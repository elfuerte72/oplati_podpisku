import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { InlineKeyboard } from 'grammy';

import { getDb, getOrderById, transitionOrder } from '@oplati/db';
import type { TelegramCallbackQuery } from '@oplati/types';

import {
  filterCatalogForDisplay,
  groupCatalog,
  type CatalogService,
} from '@/lib/catalog/build';
import { findCatalogService, loadCatalog } from '@/lib/catalog/load';
import { proposeFromCatalog } from '@/lib/catalog/propose';
import { formatExpires } from '@/components/comic/format';
import { childLogger } from '@/lib/logger';
import { currentBuyerFeePercent } from '@/lib/payments/gateway';
import { PROVIDER_UNAVAILABLE_TEXT } from '@/lib/loveandpay/availability';
import {
  aboveMaxAmountText,
  confirmOrder,
  EmailRequiredError,
  PhoneRequiredError,
  OrderAboveMaxAmountError,
  OrderExpiredError,
  PaymentProviderUnavailableError,
} from '@/lib/tool-handlers/confirm-order';

import { maxAmountUsdFor, parseCustomAmountUsd } from './amount';
import { askForContactBeforeInvoice } from './contact-flow';
import { getBot } from './bot';
import { resolveCallbackContext, safeAppendMessage, type PersistContext } from './persist';
import { sendSafely, showOrEdit, withTypingIndicator } from './send';
import {
  catalogAmountInvalidText,
  CATALOG_BACK_BUTTON,
  CATALOG_LIST_PROMPT,
  CATALOG_OWN_VARIANT_BUTTON,
  CATALOG_UNAVAILABLE_TEXT,
  catalogCustomAmountPrompt,
  catalogTierButtonLabel,
  catalogTierPrompt,
  buildBuyerFeeLine,
  orderCardText,
  PAYMENT_PENDING_HINT,
} from './templates';

/**
 * Кнопочный каталог в чате бота (список сервисов → тарифы/сумма → карточка
 * заказа) и действия «Подтвердить»/«Отменить» на карточке (выделено из
 * handle-update.ts при распиле M-10, поведение 1:1). Каталожные экраны — за
 * флагом BOT_AI_ENABLED (гейт в диспетчере callback'ов).
 */

const log = childLogger('telegram-bot');

/** Ключ pending-state в meta assistant-сообщения: «жду сумму для этого slug». */
const AWAITING_AMOUNT_META_KEY = 'awaiting_amount_for_slug';

export function buildConfirmKeyboard(orderId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Подтвердить', `confirm:${orderId}`)
    .text('Отменить', `cancel:${orderId}`);
}

/** Кнопка «<< Назад к списку» (вернуться к выбору сервиса). */
function buildBackKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(CATALOG_BACK_BUTTON, 'back');
}

/**
 * Клавиатура списка сервисов: заголовок темы строкой (не-кликабельный `noop`),
 * под ним сервисы по 2 в ряд; внизу «Свой вариант». Темы и порядок — общий
 * `groupCatalog` (тот же, что на сайте), чтобы список не висел сплошной стеной.
 */
function buildServiceListKeyboard(services: CatalogService[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const group of groupCatalog(services)) {
    kb.text(`— ${group.label} —`, 'noop').row();
    for (let i = 0; i < group.services.length; i += 2) {
      const a = group.services[i];
      const b = group.services[i + 1];
      if (a) kb.text(a.name, `svc:${a.slug}`);
      if (b) kb.text(b.name, `svc:${b.slug}`);
      kb.row();
    }
  }
  kb.text(CATALOG_OWN_VARIANT_BUTTON, 'own');
  return kb;
}

/**
 * Клавиатура тарифов сервиса: по одному в ряд (лейбл с ценой) + «Назад».
 * callback_data несёт стабильный ключ тарифа `period:usdCents` (L-20 аудита):
 * прежний индекс в живом кэше каталога протухал при переупорядочивании тарифов —
 * старая кнопка в истории чата создавала бы ДРУГОЙ тариф.
 */
function buildTierListKeyboard(slug: string, tiers: CatalogService['tiers']): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const t of tiers) {
    kb.text(catalogTierButtonLabel(t), `tier:${slug}:${t.period}:${t.usdCents}`).row();
  }
  kb.text(CATALOG_BACK_BUTTON, 'back');
  return kb;
}

/**
 * Показать список сервисов кнопочного каталога (зеркало StartScreen сайта).
 * При недоступности каталога (БД/курс) — деградируем текстом, без падения.
 */
export async function showCatalogList(
  chatId: number,
  messageId: number | undefined,
  updateId: number,
): Promise<void> {
  let services: CatalogService[] = [];
  try {
    services = filterCatalogForDisplay(await loadCatalog());
  } catch (err) {
    log.error({ event: 'telegram.catalog.load_failed', updateId, err });
    Sentry.captureException(err, { tags: { source: 'telegram.catalog', step: 'load' } });
  }
  if (services.length === 0) {
    await showOrEdit(chatId, messageId, CATALOG_UNAVAILABLE_TEXT, updateId);
    return;
  }
  await showOrEdit(
    chatId,
    messageId,
    CATALOG_LIST_PROMPT,
    updateId,
    buildServiceListKeyboard(services),
  );
}

/**
 * Выбран сервис (`svc:<slug>`). Сервис с фиксированными тарифами → показываем
 * тарифы. Custom-amount (Airbnb) → просим написать сумму и ставим pending-state
 * (флаг в meta assistant-сообщения), который подхватит следующий текст.
 */
export async function handleServiceSelected(
  cb: TelegramCallbackQuery,
  chatId: number,
  messageId: number | undefined,
  slug: string,
  updateId: number,
): Promise<void> {
  let service: CatalogService | null = null;
  try {
    service = await findCatalogService(slug);
  } catch (err) {
    log.error({ event: 'telegram.catalog.service_lookup_failed', updateId, slug, err });
    Sentry.captureException(err, { tags: { source: 'telegram.catalog', step: 'svc' } });
  }
  if (!service) {
    await showOrEdit(chatId, messageId, CATALOG_UNAVAILABLE_TEXT, updateId);
    return;
  }

  if (service.customAmount) {
    const ctx = await resolveCallbackContext(cb, updateId);
    if (!ctx) {
      await showOrEdit(chatId, messageId, CATALOG_UNAVAILABLE_TEXT, updateId);
      return;
    }
    const prompt = catalogCustomAmountPrompt(service);
    // pending-state: следующий текст-число оформит заказ по этому slug мимо AI.
    await safeAppendMessage(
      ctx,
      'assistant',
      prompt,
      { source: 'catalog_ui', [AWAITING_AMOUNT_META_KEY]: slug },
      updateId,
    );
    await showOrEdit(chatId, messageId, prompt, updateId, buildBackKeyboard());
    return;
  }

  if (service.tiers.length === 0) {
    await showOrEdit(chatId, messageId, CATALOG_UNAVAILABLE_TEXT, updateId);
    return;
  }
  await showOrEdit(
    chatId,
    messageId,
    catalogTierPrompt(service.name),
    updateId,
    buildTierListKeyboard(slug, service.tiers),
  );
}

/**
 * Выбран тариф (`tier:<slug>:<period>:<usdCents>`). Резолвим тариф из каталога
 * по стабильному ключу (цена строго серверная) и создаём заказ через общий
 * `proposeFromCatalog`; легаси-индексы отвергаются в resolveTier. Успех —
 * редактируем сообщение в карточку заказа с кнопками «Подтвердить»/«Отменить».
 */
export async function handleTierSelected(
  cb: TelegramCallbackQuery,
  chatId: number,
  messageId: number | undefined,
  slug: string,
  tierRef: readonly string[],
  updateId: number,
): Promise<void> {
  const ctx = await resolveCallbackContext(cb, updateId);
  if (!ctx) {
    await showOrEdit(chatId, messageId, CATALOG_UNAVAILABLE_TEXT, updateId);
    return;
  }

  let service: CatalogService | null = null;
  try {
    service = await findCatalogService(slug);
  } catch (err) {
    log.error({ event: 'telegram.catalog.service_lookup_failed', updateId, slug, err });
    Sentry.captureException(err, { tags: { source: 'telegram.catalog', step: 'tier' } });
  }
  const tier = service ? resolveTier(service.tiers, tierRef) : undefined;
  if (!service || !tier) {
    await showOrEdit(
      chatId,
      messageId,
      'Этот тариф уже недоступен. Нажми /menu, чтобы открыть список заново.',
      updateId,
    );
    return;
  }

  const result = await withTypingIndicator(chatId, () =>
    proposeFromCatalog({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      channel: 'telegram',
      slug,
      tierName: tier.name,
      tierPeriod: tier.period,
    }),
  );
  if (!result.ok) {
    await showOrEdit(chatId, messageId, result.text, updateId);
    return;
  }
  await showOrEdit(
    chatId,
    messageId,
    orderCardText(result.card),
    updateId,
    buildConfirmKeyboard(result.card.orderId),
  );
}

/**
 * Резолв тарифа по callback-ссылке: ТОЛЬКО стабильный ключ `[period, usdCents]`
 * (L-20). Легаси-индексы со старых сообщений осознанно НЕ резолвим: каталог с
 * тех пор переупорядочивался, и индекс по живому кэшу попал бы в ДРУГОЙ тариф —
 * ровно баг, который закрывает L-20. Старая кнопка получит честное «тариф уже
 * недоступен, открой /menu».
 */
function resolveTier(
  tiers: CatalogService['tiers'],
  tierRef: readonly string[],
): CatalogService['tiers'][number] | undefined {
  if (tierRef.length !== 2) return undefined;
  const [period, cents] = tierRef;
  const usdCents = Number(cents);
  if (!Number.isInteger(usdCents)) return undefined;
  return tiers.find((t) => t.period === period && t.usdCents === usdCents);
}

/**
 * Кнопочный флоу: если бот ранее (выбор custom-amount сервиса) попросил сумму —
 * следующий текст трактуем как неё и оформляем заказ напрямую, мимо AI.
 * Возвращает `true`, если сообщение обработано здесь (caller прекращает обычный
 * путь). `meta` — pending-state (meta последнего assistant-сообщения), прочитан
 * вызывающим один раз.
 */
export async function tryHandlePendingAmount(
  ctx: PersistContext,
  chatId: number,
  text: string,
  meta: Record<string, unknown> | null,
  updateId: number,
): Promise<boolean> {
  const slug = meta?.[AWAITING_AMOUNT_META_KEY];
  if (typeof slug !== 'string' || slug.length === 0) {
    return false;
  }

  const parsed = parseCustomAmountUsd(text, slug);
  if (parsed.kind === 'not_amount') {
    // Не число — пользователь сменил намерение; сброс ожидания, обычный путь.
    return false;
  }
  if (parsed.kind === 'invalid') {
    // Похоже на сумму, но вне диапазона/мусор — переспрашиваем, сохраняя флаг.
    const invalidText = catalogAmountInvalidText(maxAmountUsdFor(slug));
    await safeAppendMessage(
      ctx,
      'assistant',
      invalidText,
      { source: 'catalog_ui', [AWAITING_AMOUNT_META_KEY]: slug },
      updateId,
    );
    await sendSafely(chatId, invalidText, updateId);
    return true;
  }

  const result = await withTypingIndicator(chatId, () =>
    proposeFromCatalog({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      channel: 'telegram',
      slug,
      amountUsdCents: parsed.usdCents,
    }),
  );
  if (!result.ok) {
    // Заказ не создан — фиксируем ответ без флага (сброс ожидания).
    await safeAppendMessage(ctx, 'assistant', result.text, { source: 'catalog_ui' }, updateId);
    await sendSafely(chatId, result.text, updateId);
    return true;
  }
  // proposeFromCatalog уже записал след в историю (без флага) — ожидание сброшено.
  await sendSafely(
    chatId,
    orderCardText(result.card),
    updateId,
    buildConfirmKeyboard(result.card.orderId),
  );
  return true;
}

/**
 * Обработчик inline-кнопок «Подтвердить» / «Отменить» на карточке заказа.
 * Ownership: callback_data можно подделать через клиентский Bot API — нельзя
 * доверять orderId без проверки владельца. Резолвим userId по нажавшему и
 * передаём в confirmOrder / сверяем перед cancel. БД недоступна → отказ: весь
 * flow всё равно требует БД, проводить платёж по непроверенному заказу нельзя.
 */
export async function handleOrderActionCallback(
  cb: TelegramCallbackQuery,
  chatId: number,
  action: 'confirm' | 'cancel',
  orderId: string,
  updateId: number,
): Promise<void> {
  const ctx = await resolveCallbackContext(cb, updateId);
  if (!ctx) {
    await sendSafely(
      chatId,
      'Не получилось обработать действие — попробуй ещё раз через минуту.',
      updateId,
    );
    return;
  }
  const userId = ctx.userId;

  // Снимем кнопки у исходного сообщения — нельзя нажать дважды.
  if (cb.message) {
    try {
      await getBot().api.editMessageReplyMarkup(chatId, cb.message.message_id);
    } catch (err) {
      log.debug({ event: 'telegram.callback.unmark_failed', updateId, err });
    }
  }

  if (action === 'confirm') {
    let confirmResult: Awaited<ReturnType<typeof confirmOrder>>;
    try {
      confirmResult = await withTypingIndicator(chatId, () => confirmOrder({ orderId, userId }));
    } catch (err) {
      log.error({ event: 'telegram.callback.confirm.failed', updateId, orderId, err });
      Sentry.captureException(err, {
        tags: { source: 'telegram.callback', step: 'confirm' },
        extra: { orderId },
      });
      // Лимит операции шлюза — не сбой провайдера: ретрай не поможет, и
      // оператора эта ветка не зовёт (звала бы неправду).
      if (err instanceof OrderAboveMaxAmountError) {
        await sendSafely(chatId, aboveMaxAmountText(err.maxAmountRub), updateId);
        return;
      }
      // Фиксация цены протухла (H-2): заказ захоронен сервером, повтор
      // бессмысленен. Раньше этот кейс попадал в generic-ветку ниже и клиент
      // ждал оператора вместо того, чтобы оформить заказ заново (ревью 2026-08-12).
      if (err instanceof OrderExpiredError) {
        await sendSafely(
          chatId,
          'Срок фиксации цены истёк — оформи заказ заново, сумма пересчитается по свежему курсу.',
          updateId,
        );
        return;
      }
      // Транспорт до шлюза лежит: заказ жив, помогает именно повтор позже.
      // Веб и кабинет говорят это же одним общим текстом.
      if (err instanceof PaymentProviderUnavailableError) {
        await sendSafely(chatId, PROVIDER_UNAVAILABLE_TEXT, updateId);
        return;
      }
      // Сумма от порога, а номера в профиле нет (тикет 06): reply-кнопка
      // request_contact, счёт выставится после получения контакта.
      if (err instanceof PhoneRequiredError) {
        await askForContactBeforeInvoice({
          ctx,
          chatId,
          orderId,
          thresholdRub: err.requiredFromRub,
          updateId,
        });
        return;
      }
      // Профиль без почты (антифрод-трек, Р2): в чате бота поля ввода нет —
      // ведём в кабинет, где на экране заказа есть плашка контактов.
      if (err instanceof EmailRequiredError) {
        await sendSafely(
          chatId,
          'Почти готово! Для выставления счёта нужна почта для связи по заказу. Открой заказ в кабинете (кнопка «Личный кабинет» в /start-меню), укажи почту на экране заказа — и оплата откроется там же.',
          updateId,
        );
        return;
      }
      // Generic-ветка. Оператора здесь никто не зовёт (в коде только Sentry),
      // поэтому и обещать его нельзя — обещание контакта, которого не будет,
      // хуже честного «попробуй ещё раз».
      await sendSafely(
        chatId,
        'Не получилось создать счёт прямо сейчас — техническая проблема. Попробуй ещё раз через минуту, а если не выйдет — напиши /support.',
        updateId,
      );
      return;
    }

    const replyParts = [`Счёт готов. Оплата:\n${confirmResult.paymentUrl}`];
    if (confirmResult.qrPayload) {
      replyParts.push('Или отсканируй QR-код в приложении банка по СБП.');
    }
    // Надбавку платёжной системы клиент увидит на её странице — предупреждаем
    // здесь, вместе со ссылкой, а не постфактум.
    const feeLine = buildBuyerFeeLine(currentBuyerFeePercent());
    if (feeLine) replyParts.push(feeLine);
    replyParts.push(`Счёт действует до ${formatExpires(confirmResult.expiresAt)}.`);
    replyParts.push(PAYMENT_PENDING_HINT);
    const reply = replyParts.join('\n\n');

    await sendSafely(chatId, reply, updateId);
    return;
  }

  // action === 'cancel'
  try {
    const db = getDb();
    const order = await getOrderById(db, orderId);
    // Не раскрываем существование чужого заказа — тот же ответ, что и not-found.
    if (!order || order.userId !== userId) {
      if (order && order.userId !== userId) {
        log.warn({ event: 'telegram.callback.cancel.ownership_mismatch', updateId, orderId });
        Sentry.captureMessage('cancel callback: ownership mismatch', {
          level: 'warning',
          tags: { source: 'telegram.callback', step: 'cancel' },
          extra: { orderId },
        });
      }
      await sendSafely(chatId, 'Заказ уже не найден. Если хочешь начать заново — напиши /start.', updateId);
      return;
    }
    // cancel валиден только из draft/clarifying/ready_for_payment/pending_payment.
    // Если order уже paid/in_fulfillment/etc — transitionOrder бросит OrderTransitionError.
    await transitionOrder(db, {
      orderId,
      toStatus: 'cancelled',
      actorType: 'user',
      eventType: 'user_cancelled',
      payload: { source: 'telegram_inline_button' },
    });
    await sendSafely(chatId, 'Заказ отменён. Если передумаешь — напиши /start.', updateId);
  } catch (err) {
    log.error({ event: 'telegram.callback.cancel.failed', updateId, orderId, err });
    Sentry.captureException(err, {
      tags: { source: 'telegram.callback', step: 'cancel' },
      extra: { orderId },
    });
    await sendSafely(chatId, 'Не получилось отменить заказ. Напиши «оператор», подключу человека.', updateId);
  }
}
