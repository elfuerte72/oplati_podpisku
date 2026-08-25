import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { consumeLinkToken, getDb, getOrdersByUserId, LINK_TOKEN_PREFIX } from '@oplati/db';
import type { TelegramMessage, TelegramUpdate } from '@oplati/types';

import { formatExpires, formatRub } from '@/components/comic/format';
import { childLogger } from '@/lib/logger';
import { fulfillmentCapacityText } from '@/lib/payments/capacity';
import { currentBuyerFeePercent } from '@/lib/payments/gateway';
import {
  confirmOrder,
  EmailRequiredError,
  PaymentCapacityError,
  PhoneRequiredError,
} from '@/lib/tool-handlers/confirm-order';

import { askForContactBeforeInvoice } from './contact-flow';
import { persistInbound, safeAppendMessage } from './persist';
import { sendSafely } from './send';
import { buildBuyerFeeLine, PAYMENT_PENDING_HINT } from './templates';

/**
 * Привязка веб-сессии к Telegram: deep-link `/start link_<token>` + handoff
 * незавершённого заказа (выделено из handle-update.ts при распиле M-10,
 * поведение 1:1).
 */

const log = childLogger('telegram-bot');
const dbLog = childLogger('db');

const LINK_SUCCESS_TEXT =
  'Готово, Telegram привязан! Теперь чеки об оплате и доступы по заказам с сайта будут приходить сюда. Возвращайся на сайт — Оплатишка уже в курсе.';
const LINK_INVALID_TEXT =
  'Эта ссылка привязки устарела или уже использована. Вернись на сайт и нажми «Связать Telegram» ещё раз — пришлю свежую.';
const LINK_FAIL_TEXT =
  'Не получилось привязать прямо сейчас — что-то на нашей стороне. Попробуй ещё раз через минуту.';

/**
 * Завершение привязки веб-сессии: пользователь пришёл по deep-link
 * `telegram.me/<bot>?start=link_<token>` с сайта. Токен выпущен
 * `POST /api/auth/telegram/link`, потребление одноразовое (consumeLinkToken).
 *
 * Если у пользователя уже была история и в боте, и на сайте — consumeLinkToken
 * сольёт две users-строки в одну (выживает telegram-строка). Сообщения
 * персистим как обычный диалог, чтобы привязка была видна в истории.
 */
export async function handleLinkDeepLink(
  update: TelegramUpdate,
  message: TelegramMessage,
  startPayload: string,
): Promise<void> {
  const chatId = message.chat.id;
  const telegramUserId = message.from?.id;

  if (!telegramUserId) {
    log.warn({ event: 'telegram.link.skipped', updateId: update.update_id, reason: 'no_from_id' });
    await sendSafely(chatId, LINK_FAIL_TEXT, update.update_id);
    return;
  }

  const token = startPayload.slice(LINK_TOKEN_PREFIX.length);
  const displayNameParts = [message.from?.first_name, message.from?.last_name].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );

  let replyText: string;
  try {
    const result = await consumeLinkToken(
      getDb(),
      {
        token,
        telegramId: String(telegramUserId),
        displayName: displayNameParts.length > 0 ? displayNameParts.join(' ') : null,
      },
      dbLog,
    );
    if (result.ok) {
      log.info({
        event: 'telegram.link.ok',
        updateId: update.update_id,
        userId: result.userId,
        merged: result.merged,
        alreadyLinked: result.alreadyLinked,
      });
      // Handoff незавершённого заказа: пользователь чаще всего приходит сюда
      // с мобильного сайта, упёршись в гейт оплаты. Возврат в браузер — самое
      // хрупкое звено (вкладка умирает, поллинг спит), поэтому если у него
      // есть свежий заказ, ждущий оплаты, — выставляем счёт и даём оплатить
      // прямо здесь, возвращаться на сайт не нужно.
      const handoff = await buildPendingOrderHandoffTextBounded(result.userId, update.update_id);
      if (handoff !== null && typeof handoff !== 'string') {
        // Сумма от порога, а номера в профиле нет (тикет 06): привязка удалась,
        // счёт выставится после того, как клиент поделится контактом.
        const ctxForContact = await persistInbound(update, message);
        if (ctxForContact) {
          await safeAppendMessage(
            ctxForContact,
            'user',
            '/start (привязка Telegram с сайта)',
            { telegram_update_id: update.update_id, telegram_message_id: message.message_id },
            update.update_id,
          );
        }
        await sendSafely(chatId, LINK_SUCCESS_TEXT, update.update_id);
        await askForContactBeforeInvoice({
          ctx: ctxForContact,
          chatId,
          orderId: handoff.needContact.orderId,
          thresholdRub: handoff.needContact.thresholdRub,
          updateId: update.update_id,
        });
        return;
      }
      replyText = handoff ?? LINK_SUCCESS_TEXT;
    } else {
      log.info({ event: 'telegram.link.rejected', updateId: update.update_id, reason: result.reason });
      replyText = LINK_INVALID_TEXT;
    }
  } catch (err) {
    log.error({ event: 'telegram.link.failed', updateId: update.update_id, err });
    Sentry.captureException(err, { tags: { source: 'telegram.link' } });
    replyText = LINK_FAIL_TEXT;
  }

  // Персист диалога — обычный путь (после consumeLinkToken, чтобы upsert
  // пользователя не создал telegram-строку до merge без необходимости).
  const ctx = await persistInbound(update, message);
  if (ctx) {
    await safeAppendMessage(
      ctx,
      'user',
      '/start (привязка Telegram с сайта)',
      { telegram_update_id: update.update_id, telegram_message_id: message.message_id },
      update.update_id,
    );
    await safeAppendMessage(ctx, 'assistant', replyText, { source: 'telegram_link' }, update.update_id);
  }

  await sendSafely(chatId, replyText, update.update_id);
}

/** Свежесть заказа для handoff после привязки: старые брошенные черновики не воскрешаем. */
const LINK_HANDOFF_ORDER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Потолок ожидания handoff-счёта: создание инвойса (self-call payments/create →
 * L&P) может тянуться до 60 с, а подтверждение привязки не должно висеть из-за
 * платёжного провайдера. По таймауту — стандартный успех-текст (graceful
 * degradation); если инвойс всё же создастся позже, повторный confirm с сайта
 * идемпотентно вернёт ту же ссылку (repeat_confirm).
 */
const LINK_HANDOFF_TIMEOUT_MS = 15_000;

/** Маркер «привязано, но перед счётом нужен номер» (тикет 06). */
type HandoffNeedsContact = { needContact: { orderId: string; thresholdRub: number | null } };

async function buildPendingOrderHandoffTextBounded(
  userId: string,
  updateId: number,
): Promise<string | HandoffNeedsContact | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), LINK_HANDOFF_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([buildPendingOrderHandoffText(userId, updateId), timeout]);
    if (result === 'timeout') {
      log.warn({ event: 'telegram.link.handoff_timeout', updateId });
      return null;
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Если у только что привязавшегося пользователя есть свежий заказ в
 * `ready_for_payment` (гейт оплаты на сайте) — выставляем счёт тем же
 * `confirmOrder`, что и веб, и возвращаем готовое сообщение «привязано +
 * ссылка на оплату». Best-effort: любой сбой → null (привязка удалась,
 * стандартный успех-текст уйдёт как обычно). Повторный вызов безопасен:
 * `payments/create` идемпотентен и на гонку (unique pending-инвойс), и на
 * последовательный повтор (repeat_confirm возвращает существующий счёт) —
 * веб-вкладка, повторившая подтверждение после привязки, получит ту же ссылку.
 */
async function buildPendingOrderHandoffText(
  userId: string,
  updateId: number,
): Promise<string | HandoffNeedsContact | null> {
  try {
    const recentOrders = await getOrdersByUserId(getDb(), userId, 10);
    const cutoff = Date.now() - LINK_HANDOFF_ORDER_MAX_AGE_MS;
    const pending = recentOrders.find(
      (o) =>
        o.status === 'ready_for_payment' &&
        o.amountRub !== null &&
        o.amountRub > 0 &&
        o.createdAt.getTime() >= cutoff,
    );
    if (!pending) return null;

    let confirmResult;
    try {
      confirmResult = await confirmOrder({ orderId: pending.id, userId });
    } catch (err) {
      // Сумма от порога, номера нет (тикет 06): не текст, а просьба поделиться
      // контактом — счёт выставится после него (обрабатывает вызывающий код).
      if (err instanceof PhoneRequiredError) {
        log.info({ event: 'telegram.link.handoff_phone_required', updateId, orderId: pending.id });
        return {
          needContact: { orderId: pending.id, thresholdRub: err.requiredFromRub },
        };
      }
      throw err;
    }
    log.info({
      event: 'telegram.link.handoff_invoice_created',
      updateId,
      orderId: pending.id,
    });

    const parts = [
      `Готово, Telegram привязан! Твой заказ ${pending.shortId} на ${formatRub(pending.amountRub ?? 0)} уже ждёт — счёт готов, оплатить можно прямо отсюда:\n${confirmResult.paymentUrl}`,
    ];
    if (confirmResult.qrPayload) {
      parts.push('Или отсканируй QR-код в приложении банка по СБП.');
    }
    const feeLine = buildBuyerFeeLine(currentBuyerFeePercent(), pending.amountRub ?? 0);
    if (feeLine) parts.push(feeLine);
    parts.push(
      `Счёт действует до ${formatExpires(confirmResult.expiresAt)}. Чек и доступы после оплаты придут сюда, в Telegram.`,
    );
    parts.push(PAYMENT_PENDING_HINT);
    return parts.join('\n\n');
  } catch (err) {
    // Профиль без почты (антифрод-трек): заказ оформлен ДО фичи плашки
    // контактов — счёт не выставить, но молчать нельзя: клиент пришёл сюда
    // именно оплатить. Говорим, где указать почту, вместо тишины.
    if (err instanceof EmailRequiredError) {
      log.info({ event: 'telegram.link.handoff_email_required', updateId });
      return (
        'Готово, Telegram привязан! Остался один шаг до оплаты: укажи почту для связи по заказу — открой заказ в кабинете (кнопка «Личный кабинет» в /start-меню), поле почты там, на экране заказа. После этого счёт выставится там же.'
      );
    }
    // Карточного фонда не хватает (трек vcc-preflight): счёт не выставлен, но
    // клиент шёл по ссылке ИМЕННО оплатить — тишина после «привязан!» оставила
    // бы его гадать, куда делся счёт. Это штатный исход, а не сбой: про него
    // кричит свой алёрт владельцу, и Sentry шуметь незачем.
    if (err instanceof PaymentCapacityError) {
      log.info({ event: 'telegram.link.handoff_fulfillment_capacity', updateId });
      return `Готово, Telegram привязан! ${fulfillmentCapacityText(err.priceLockMinutesLeft)}`;
    }
    // Привязку из-за счёта не роняем: уйдёт стандартный LINK_SUCCESS_TEXT,
    // пользователь оплатит с сайта или из кабинета.
    log.error({ event: 'telegram.link.handoff_failed', updateId, err });
    Sentry.captureException(err, { tags: { source: 'telegram.link', step: 'handoff' } });
    return null;
  }
}
