import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { Keyboard } from 'grammy';

import { getDb, getLastAssistantMessageMeta, updateUserContacts } from '@oplati/db';
import type { TelegramMessage, TelegramUpdate } from '@oplati/types';

import { normalizeTelegramPhone, phoneFieldHint } from '../contacts/phone.ts';
import { childLogger } from '../logger.ts';
import {
  confirmOrder,
  EmailRequiredError,
  OrderExpiredError,
  PaymentProviderUnavailableError,
} from '../tool-handlers/confirm-order.ts';
import { PROVIDER_UNAVAILABLE_TEXT } from '../loveandpay/availability.ts';
import { currentBuyerFeePercent } from '../payments/gateway.ts';
import { formatExpires } from '@/components/comic/format';
import { buildBuyerFeeLine } from './templates.ts';
import { persistInbound, safeAppendMessage, type PersistContext } from './persist.ts';
import { sendSafely } from './send.ts';

/**
 * Сбор телефона в боте (антифрод-трек, тикет 06): полей ввода в чате нет —
 * перед выставлением счёта на сумму от порога бот показывает reply-кнопку
 * `request_contact`, счёт выставляется ПОСЛЕ получения контакта.
 *
 * Безопасность: контакт принимается только если `contact.user_id` равен
 * отправителю апдейта — из адресной книги можно отправить ЧУЖОЙ контакт, и
 * без проверки клиент привязал бы к оплате чей угодно номер.
 */

const log = childLogger('telegram-bot');

/** Ключ pending-state в meta assistant-сообщения: «жду контакт для заказа X». */
export const AWAITING_CONTACT_META_KEY = 'awaiting_contact_for_order';

const SHARE_CONTACT_BUTTON = 'Поделиться номером';

/** Снятие reply-клавиатуры после обработки контакта. */
const REMOVE_KEYBOARD = { remove_keyboard: true as const };

/**
 * Попросить номер перед выставлением счёта: reply-кнопка + pending-флаг.
 * `ctx` может быть null (БД недоступна) — кнопку всё равно показываем;
 * обработчик контакта тогда просто сохранит номер и позовёт оплатить заново.
 */
export async function askForContactBeforeInvoice(params: {
  ctx: PersistContext | null;
  chatId: number;
  orderId: string;
  thresholdRub: number | null;
  updateId: number;
}): Promise<void> {
  const { ctx, chatId, orderId, thresholdRub, updateId } = params;
  const text =
    `${thresholdRub !== null ? phoneFieldHint(thresholdRub) : 'Банк требует телефон плательщика для этой суммы.'} ` +
    `Нажми кнопку «${SHARE_CONTACT_BUTTON}» под полем ввода — счёт выставлю сразу после этого.`;

  if (ctx) {
    await safeAppendMessage(
      ctx,
      'assistant',
      text,
      { source: 'contact_flow', [AWAITING_CONTACT_META_KEY]: orderId },
      updateId,
    );
  }
  await sendSafely(
    chatId,
    text,
    updateId,
    new Keyboard().requestContact(SHARE_CONTACT_BUTTON).resized().oneTime(),
  );
}

/**
 * Обработка сообщения с контактом. Вызывается из диспатчера апдейтов ДО
 * media-ветки. Всегда снимает reply-клавиатуру ответом.
 */
export async function handleContactMessage(
  update: TelegramUpdate,
  message: TelegramMessage,
): Promise<void> {
  const updateId = update.update_id;
  const chatId = message.chat.id;
  const contact = message.contact;
  const fromId = message.from?.id;
  if (!contact || !fromId) return;

  // Чужой контакт из адресной книги — отказ (тикет 06). user_id отсутствует и
  // у номеров без аккаунта Telegram: такой контакт тоже не принимаем — это
  // точно не «свой номер» отправителя.
  if (contact.user_id !== fromId) {
    log.warn({ event: 'telegram.contact.foreign_rejected', updateId, chatId });
    await sendSafely(
      chatId,
      'Это чужой контакт — нужен именно твой номер. Нажми кнопку «Поделиться номером» под полем ввода.',
      updateId,
    );
    return;
  }

  const phone = normalizeTelegramPhone(contact.phone_number);
  if (!phone) {
    log.warn({ event: 'telegram.contact.unparsable_phone', updateId, chatId });
    await sendSafely(
      chatId,
      'Не получилось разобрать номер. Попробуй ещё раз или напиши /support.',
      updateId,
      REMOVE_KEYBOARD,
    );
    return;
  }

  const ctx = await persistInbound(update, message);
  if (!ctx) {
    await sendSafely(
      chatId,
      'Номер получил, но сохранить прямо сейчас не вышло — попробуй ещё раз через минуту.',
      updateId,
      REMOVE_KEYBOARD,
    );
    return;
  }

  try {
    await updateUserContacts(getDb(), { userId: ctx.userId, phone, phoneSource: 'telegram' });
  } catch (err) {
    log.error({ event: 'telegram.contact.save_failed', updateId, err });
    Sentry.captureException(err, { tags: { source: 'telegram.contact' } });
    await sendSafely(
      chatId,
      'Номер получил, но сохранить прямо сейчас не вышло — попробуй ещё раз через минуту.',
      updateId,
      REMOVE_KEYBOARD,
    );
    return;
  }
  await safeAppendMessage(
    ctx,
    'user',
    '[контакт с номером телефона]',
    { telegram_update_id: updateId, telegram_message_id: message.message_id },
    updateId,
  );

  // Ждали ли номер ради конкретного заказа (handoff / подтверждение в боте)?
  // Контакт может прийти и БЕЗ флага — например, из кнопки «Взять из Telegram»
  // в Mini App: requestContact не отдаёт номер приложению (проверено по доке
  // 2026-08-15, событие несёт только status), Telegram шлёт его боту этим же
  // contact-сообщением.
  const pendingOrderId = await readPendingOrderId(ctx);
  if (!pendingOrderId) {
    const doneText =
      'Номер сохранён! Если оформлял заказ — вернись к нему и нажми «Оплатить» ещё раз.';
    await safeAppendMessage(ctx, 'assistant', doneText, { source: 'contact_flow' }, updateId);
    await sendSafely(chatId, doneText, updateId, REMOVE_KEYBOARD);
    return;
  }

  await issueInvoiceAfterContact(ctx, chatId, pendingOrderId, updateId);
}

async function readPendingOrderId(ctx: PersistContext): Promise<string | null> {
  try {
    const meta = await getLastAssistantMessageMeta(getDb(), ctx.conversationId);
    const value = meta?.[AWAITING_CONTACT_META_KEY];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch (err) {
    // Не смогли прочитать флаг — номер уже сохранён, деградация мягкая.
    log.error({ event: 'telegram.contact.pending_read_failed', err });
    Sentry.captureException(err, { tags: { source: 'telegram.contact' } });
    return null;
  }
}

/** Выставить счёт после получения номера — те же тексты, что в catalog-флоу. */
async function issueInvoiceAfterContact(
  ctx: PersistContext,
  chatId: number,
  orderId: string,
  updateId: number,
): Promise<void> {
  try {
    const result = await confirmOrder({ orderId, userId: ctx.userId });
    const parts = [`Номер сохранён. Счёт готов. Оплата:\n${result.paymentUrl}`];
    if (result.qrPayload) parts.push('Или отсканируй QR-код в приложении банка по СБП.');
    const feeLine = buildBuyerFeeLine(currentBuyerFeePercent());
    if (feeLine) parts.push(feeLine);
    parts.push(`Счёт действует до ${formatExpires(result.expiresAt)}.`);
    const reply = parts.join('\n\n');
    await safeAppendMessage(ctx, 'assistant', reply, { source: 'contact_flow' }, updateId);
    await sendSafely(chatId, reply, updateId, REMOVE_KEYBOARD);
  } catch (err) {
    log.error({ event: 'telegram.contact.confirm_failed', updateId, orderId, err });
    // Ожидаемые отказы — свои тексты; прочее — generic + Sentry.
    let reply =
      'Номер сохранён, но счёт выставить не получилось — попробуй нажать «Оплатить» ещё раз через минуту.';
    if (err instanceof OrderExpiredError) {
      reply = 'Номер сохранён, но срок фиксации цены истёк — оформи заказ заново.';
    } else if (err instanceof PaymentProviderUnavailableError) {
      reply = `Номер сохранён. ${PROVIDER_UNAVAILABLE_TEXT}`;
    } else if (err instanceof EmailRequiredError) {
      reply =
        'Номер сохранён. Осталась почта: открой заказ в кабинете (кнопка «Личный кабинет» в /start-меню) и укажи её там.';
    } else {
      Sentry.captureException(err, { tags: { source: 'telegram.contact', step: 'confirm' } });
    }
    await safeAppendMessage(ctx, 'assistant', reply, { source: 'contact_flow' }, updateId);
    await sendSafely(chatId, reply, updateId, REMOVE_KEYBOARD);
  }
}
