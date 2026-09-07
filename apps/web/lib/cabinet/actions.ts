import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { fulfillmentCapacityText } from '../payments/capacity.ts';
import {
  appendOrderEvent,
  claimPaymentTerminal,
  findCardByIdForUser,
  findPaymentsByOrderId,
  findPendingPaymentByOrderId,
  getDb,
  getOrderById,
  getOrCreateActiveConversation,
  getServiceById,
  getUserProfileById,
  hasRecentOrderEvent,
  transitionOrder,
} from '@oplati/db';
import { orderParameters, OrderTransitionError, type OrderStatus } from '@oplati/types';

import { EMAIL_REQUIRED_TEXT } from '../contacts/email.ts';
import { PHONE_REQUIRED_FALLBACK_TEXT, phoneRequiredText } from '../contacts/phone.ts';
import { childLogger } from '../logger.ts';
import { PROVIDER_UNAVAILABLE_TEXT } from '../loveandpay/availability.ts';
import {
  confirmOrder,
  aboveMaxAmountText,
  EmailRequiredError,
  OrderAboveMaxAmountError,
  PaymentCapacityError,
  OrderExpiredError,
  PaymentProviderUnavailableError,
  PhoneRequiredError,
  TelegramLinkRequiredError,
} from '../tool-handlers/confirm-order.ts';
import { proposeFromCatalog } from '../catalog/propose.ts';
import {
  buildPaymentIssueOperatorMessage,
  buildPaymentProblemOperatorMessage,
} from '../telegram/templates.ts';
import { sendToSupportOperator } from '../telegram/support.ts';
import {
  PAYMENT_PROBLEM_EVENT,
  type PaymentIssueType,
  type PaymentProblemType,
} from './payment-issues.ts';
import {
  CARD_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  PAYMENT_ISSUE_EVENT,
  SUBSCRIPTION_ACTIVATED_EVENT,
  isPayableStatus,
} from './types.ts';

/**
 * Действия личного кабинета (Mini App). Каждое начинается с проверки
 * ownership (`order.userId === userId`) — `callback_data`/`orderId` от клиента
 * подделываемы, доверять им нельзя (тот же принцип, что в callback-хендлерах
 * Telegram-бота). Личность пользователя установлена проверенным initData выше.
 */

const log = childLogger('cabinet.actions');
const dbLog = childLogger('db');

// ─── Оплатить незавершённый заказ ─────────────────────────────────────────

export type PayOrderResult =
  | { ok: true; paymentUrl: string; qrPayload: string | null; expiresAt: string | null }
  | {
      ok: false;
      error:
        | 'not_found'
        | 'not_payable'
        | 'invoice_unavailable'
        | 'link_required'
        | 'email_required'
        | 'phone_required'
        | 'failed';
      message: string;
      /** Порог гейта телефона в целых рублях (только при phone_required). */
      requiredFromRub?: number | null;
    };

/** Достаёт платёжную ссылку из сохранённого invoice (для уже выставленного счёта). */
export function extractInvoiceLink(
  rawPayload: Record<string, unknown> | null,
): { paymentUrl: string; qrPayload: string | null; expiresAt: string | null } | null {
  if (!rawPayload || typeof rawPayload !== 'object') return null;
  const invoice = (rawPayload as { invoice?: unknown }).invoice;
  if (!invoice || typeof invoice !== 'object') return null;
  const inv = invoice as { paymentLink?: unknown; qrPayload?: unknown; expiresAt?: unknown };
  if (typeof inv.paymentLink !== 'string' || inv.paymentLink.length === 0) return null;
  return {
    paymentUrl: inv.paymentLink,
    qrPayload: typeof inv.qrPayload === 'string' ? inv.qrPayload : null,
    expiresAt: typeof inv.expiresAt === 'string' ? inv.expiresAt : null,
  };
}

export async function payOrder(userId: string, orderId: string): Promise<PayOrderResult> {
  const db = getDb();
  const order = await getOrderById(db, orderId);
  if (!order || order.userId !== userId) {
    return { ok: false, error: 'not_found', message: 'Заказ не найден.' };
  }
  // Протухшая фиксация цены (H-2) — специфичный текст ДО generic-гейта:
  // «нельзя оплатить» без объяснения выглядело бы как поломка.
  if (order.status === 'expired') {
    return {
      ok: false,
      error: 'not_payable',
      message: 'Срок фиксации цены истёк — оформи заказ заново.',
    };
  }
  if (!isPayableStatus(order.status)) {
    return {
      ok: false,
      error: 'not_payable',
      message: 'Этот заказ уже нельзя оплатить — он не ждёт оплаты.',
    };
  }

  // Счёт уже выставлен (pending_payment) — отдаём существующую ссылку, не плодим
  // второй invoice. `/api/payments/create` всё равно отверг бы повторный вызов (409).
  // Строго ЖИВОЙ платёж (L-5 аудита): нефильтрованный список мог отдать ссылку
  // старого failed/expired инвойса — клиент оплатил бы мёртвый счёт.
  if (order.status === 'pending_payment') {
    const pending = await findPendingPaymentByOrderId(db, orderId);
    const link = pending ? extractInvoiceLink(pending.rawPayload) : null;
    if (link) return { ok: true, ...link };
    return {
      ok: false,
      error: 'invoice_unavailable',
      message: 'Счёт уже выставлен — ссылка на оплату пришла в чат с ботом.',
    };
  }

  // ready_for_payment — создаём invoice штатным путём (confirm_order → L&P).
  try {
    const result = await confirmOrder({ orderId, userId });
    return {
      ok: true,
      paymentUrl: result.paymentUrl,
      qrPayload: result.qrPayload ?? null,
      expiresAt: result.expiresAt ?? null,
    };
  } catch (err) {
    if (err instanceof TelegramLinkRequiredError) {
      // В Mini App почти невозможно (личность из Telegram), но обрабатываем явно.
      return {
        ok: false,
        error: 'link_required',
        message: 'Нужно открыть кабинет из Telegram, чтобы получить ссылку на оплату.',
      };
    }
    // Профиль без почты (антифрод-трек, Р2): плашка контактов в UI не доводит
    // до этого — гейт ловит старые клиенты/обходы. UI покажет поле почты.
    if (err instanceof EmailRequiredError) {
      return { ok: false, error: 'email_required', message: EMAIL_REQUIRED_TEXT };
    }
    // Гейт телефона (тикет 05): UI покажет поле в плашке; порог — в message.
    if (err instanceof PhoneRequiredError) {
      return {
        ok: false,
        error: 'phone_required',
        requiredFromRub: err.requiredFromRub,
        message:
          err.requiredFromRub !== null
            ? phoneRequiredText(err.requiredFromRub)
            : PHONE_REQUIRED_FALLBACK_TEXT,
      };
    }
    // Тех. сбой транспорта до L&P — заказ жив, честный текст вместо generic.
    if (err instanceof PaymentProviderUnavailableError) {
      return { ok: false, error: 'failed', message: PROVIDER_UNAVAILABLE_TEXT };
    }
    // Гейт фиксации цены (H-2): payments/create ответил 409 order_expired —
    // заказ захоронен, «попробуй ещё раз» ввёл бы в заблуждение.
    if (err instanceof OrderExpiredError) {
      return {
        ok: false,
        error: 'not_payable',
        message: 'Срок фиксации цены истёк — оформи заказ заново.',
      };
    }
    // Лимит операции шлюза: «попробуй ещё раз через минуту» здесь враньё —
    // столько провайдер не примет никогда.
    if (err instanceof OrderAboveMaxAmountError) {
      log.info({ event: 'cabinet.pay.above_max_amount', orderId });
      return { ok: false, error: 'not_payable', message: aboveMaxAmountText(err.maxAmountRub) };
    }
    // Карточного фонда не хватает (трек vcc-preflight): счёт не выставлен,
    // заказ жив с зафиксированной ценой. Generic «попробуй через минуту» здесь
    // врало бы дважды — сбоя не было, и минуты не хватит: фонд пополняется T+1.
    if (err instanceof PaymentCapacityError) {
      log.warn({ event: 'cabinet.pay.fulfillment_capacity', orderId });
      return {
        ok: false,
        error: 'failed',
        message: fulfillmentCapacityText(err.priceLockMinutesLeft),
      };
    }
    log.error({ event: 'cabinet.pay.failed', orderId, err });
    Sentry.captureException(err, { tags: { source: 'cabinet.pay' }, extra: { orderId } });
    return {
      ok: false,
      error: 'failed',
      message: 'Не получилось создать счёт. Попробуй ещё раз через минуту.',
    };
  }
}

// ─── Отмена заказа клиентом ───────────────────────────────────────────────

export type CancelOrderResult =
  | { ok: true; invoiceClosed: boolean; message: string }
  | {
      ok: false;
      error: 'not_found' | 'not_cancellable' | 'payment_in_progress' | 'failed';
      message: string;
    };

/**
 * Текст отказа по ФАКТИЧЕСКОМУ статусу заказа: «этот заказ уже нельзя
 * отменить» одинаково описывает оплаченный заказ, протухший и отменённый
 * секунду назад из второй вкладки — а действия клиента после этого разные.
 */
function notCancellableText(status: OrderStatus): string {
  switch (status) {
    case 'cancelled':
      return 'Заказ уже отменён.';
    case 'expired':
      return 'Срок заказа истёк — он закрылся сам.';
    case 'payment_review':
      return 'Банк проверяет платёж по этому заказу — дождись решения, отменить сейчас нельзя.';
    case 'paid':
    case 'in_fulfillment':
    case 'completed':
      return 'Заказ уже оплачен — отменить его нельзя. Если что-то пошло не так, напиши в поддержку.';
    default:
      return 'Этот заказ уже нельзя отменить.';
  }
}

const PAYMENT_IN_PROGRESS_TEXT =
  'Оплата по этому заказу сейчас обрабатывается — отменять его нельзя. Обнови экран через минуту.';

/**
 * Клиент передумал: «Отменить заказ» на экране заказа в Mini App.
 *
 * Отменяем оба оплатимых статуса, включая `pending_payment` (решение владельца
 * 2026-09-07): счёт живёт час, и заказ, по которому клиент уже решил не
 * платить, всё это время держит карточный фонд (`findOrdersCommittingCardFund`
 * считает живой `pending_payment` обязательством) и мозолит глаза в списке
 * «ждут оплаты».
 *
 * ⚠️ ПОРЯДОК как в `expire-payments`: сначала атомарный claim живого платежа
 * (`pending → failed`), и только потом заказ. Наоборот — значит окно, в котором
 * заказ уже `cancelled`, а платёж ещё `pending`: пришедший в это окно вебхук
 * успешно клеймит оплату и упирается в запрещённый переход `cancelled → paid`,
 * то есть деньги приняты, а восстановить заказ нечем. Обе записи — в ОДНОЙ
 * транзакции: сорванный переход откатывает claim, и платёж остаётся живым.
 *
 * Гонка «клиент оплатил и тут же нажал отмену» остаётся возможной, но не
 * молчаливой: оплата по захороненному счёту идёт веткой `paid_after_terminal`
 * — Sentry + сообщение в ops-группу «нужен ручной возврат». Поэтому UI и
 * спрашивает подтверждение с прямым «если уже оплатил — не отменяй».
 */
export async function cancelOrder(userId: string, orderId: string): Promise<CancelOrderResult> {
  const db = getDb();
  const order = await getOrderById(db, orderId);
  if (!order || order.userId !== userId) {
    return { ok: false, error: 'not_found', message: 'Заказ не найден.' };
  }
  if (!isPayableStatus(order.status)) {
    return { ok: false, error: 'not_cancellable', message: notCancellableText(order.status) };
  }

  // Успешный платёж при заказе, ещё не доехавшем до `paid`, — рассинхрон
  // (вебхук в процессе, сорвался переход). Деньги приняты: отмена превратила
  // бы это в оплаченный, но отменённый заказ. Тот же барьер, что
  // `NOT EXISTS (succeeded)` у выборки протухших заказов.
  const existingPayments = await findPaymentsByOrderId(db, orderId);
  if (existingPayments.some((p) => p.status === 'succeeded')) {
    log.warn({ event: 'cabinet.cancel.succeeded_payment_present', orderId, status: order.status });
    return { ok: false, error: 'payment_in_progress', message: PAYMENT_IN_PROGRESS_TEXT };
  }

  const pending = await findPendingPaymentByOrderId(db, orderId);

  try {
    const cancelled = await db.transaction(async (tx) => {
      if (pending) {
        const claimed = await claimPaymentTerminal(tx, pending.id, dbLog);
        // Платёж перестал быть `pending` между чтением и claim'ом: его забрал
        // вебхук (оплата) или крон (захоронение). Кто именно — разбираем ПОСЛЕ
        // транзакции, перечитав строку; здесь просто не отменяем.
        if (!claimed) return false;
      }
      await transitionOrder(tx, {
        orderId,
        toStatus: 'cancelled',
        actorType: 'user',
        actorId: userId,
        eventType: 'user_cancelled',
        payload: {
          source: 'cabinet',
          fromStatus: order.status,
          ...(pending ? { paymentId: pending.id } : {}),
        },
      });
      return true;
    });

    if (!cancelled) {
      // Платёж увели из-под нас. Оплата — единственная причина отказать
      // клиенту; захороненный платёж отмене не мешает, и повтор её проведёт.
      const fresh = await findPaymentsByOrderId(db, orderId);
      const paid = fresh.some((p) => p.status === 'succeeded');
      log.info({ event: 'cabinet.cancel.payment_claimed_elsewhere', orderId, paid });
      return {
        ok: false,
        error: 'payment_in_progress',
        message: paid
          ? 'Оплата по заказу прошла — отменять уже нечего. Открой заказ заново.'
          : PAYMENT_IN_PROGRESS_TEXT,
      };
    }

    log.info({
      event: 'cabinet.cancel.done',
      orderId,
      fromStatus: order.status,
      invoiceClosed: pending !== null,
    });
    return {
      ok: true,
      invoiceClosed: pending !== null,
      message: pending
        ? 'Заказ отменён, счёт закрыт. Оформить заново можно в любой момент.'
        : 'Заказ отменён. Оформить заново можно в любой момент.',
    };
  } catch (err) {
    // Заказ ушёл в другой статус между проверкой и переходом (крон похоронил,
    // вебхук оплатил). Не наша ошибка — говорим клиенту, что случилось.
    if (err instanceof OrderTransitionError) {
      log.info({ event: 'cabinet.cancel.transition_race', orderId, from: err.from });
      return { ok: false, error: 'not_cancellable', message: notCancellableText(err.from) };
    }
    log.error({ event: 'cabinet.cancel.failed', orderId, err });
    Sentry.captureException(err, { tags: { source: 'cabinet.cancel' }, extra: { orderId } });
    return {
      ok: false,
      error: 'failed',
      message: 'Не получилось отменить заказ. Попробуй ещё раз через минуту.',
    };
  }
}

// ─── Новый заказ из каталога (Mini App) ───────────────────────────────────

export type ProposeNewOrderInput = {
  slug: string;
  /** Для тарифных сервисов (взаимоисключающе с amountUsdCents). */
  tierName?: string;
  tierPeriod?: 'month' | 'quarter' | 'year';
  /** Только для custom-amount сервисов; целые USD-центы. */
  amountUsdCents?: number;
};

export type ProposeNewOrderResult =
  | {
      ok: true;
      orderId: string;
      shortId: string;
      service: string;
      totalKopecks: number;
      expiresAt: string;
    }
  | { ok: false; error: 'failed'; message: string };

/**
 * Кнопочный каталог Mini App: создать заказ по slug из каталога. Цена — строго
 * серверная (`proposeFromCatalog` берёт тариф из pricing_policy; caller шлёт
 * сумму только для custom-amount сервисов, и её валидируют границы proposeOrder).
 * Личность — из проверенного initData, ownership-проверка не нужна: заказ
 * создаётся на самого пользователя.
 */
export async function proposeNewOrder(
  userId: string,
  input: ProposeNewOrderInput,
): Promise<ProposeNewOrderResult> {
  try {
    const conversation = await getOrCreateActiveConversation(
      getDb(),
      { userId, channel: 'telegram' },
      dbLog,
    );
    const result = await proposeFromCatalog({
      userId,
      conversationId: conversation.id,
      channel: 'telegram',
      slug: input.slug,
      ...(input.tierName !== undefined ? { tierName: input.tierName } : {}),
      ...(input.tierPeriod !== undefined ? { tierPeriod: input.tierPeriod } : {}),
      ...(input.amountUsdCents !== undefined ? { amountUsdCents: input.amountUsdCents } : {}),
    });
    if (!result.ok) {
      return { ok: false, error: 'failed', message: result.text };
    }
    return {
      ok: true,
      orderId: result.card.orderId,
      shortId: result.card.shortId,
      service: result.card.service,
      totalKopecks: result.card.totalKopecks,
      expiresAt: result.card.expiresAt,
    };
  } catch (err) {
    log.error({ event: 'cabinet.propose.failed', slug: input.slug, err });
    Sentry.captureException(err, { tags: { source: 'cabinet.propose' }, extra: { slug: input.slug } });
    return {
      ok: false,
      error: 'failed',
      message: 'Не получилось создать заказ. Попробуй ещё раз через минуту.',
    };
  }
}

// ─── «Не проходит оплата?» — проблема с оплатой на сайте сервиса ──────────

/** Окно дедупликации повторных жалоб по одному заказу (мс). */
const PAYMENT_ISSUE_DEDUP_MS = 5 * 60 * 1000;

export type ReportPaymentIssueResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; error: 'not_found' | 'not_available' | 'failed'; message: string };

/**
 * Клиент нажал «Не проходит оплата?» и выбрал тип проблемы (ТЗ §6). В поддержку
 * автоматически уходит весь контекст: номер заказа, сервис, тариф, сумма,
 * статус карты и тип ошибки. Плюс append-only event в `order_events` —
 * на экране заказа появляется статус «Возникла проблема». Статус-машину заказа
 * не трогаем (completed остаётся терминальным).
 */
export async function reportPaymentIssue(
  userId: string,
  telegramId: string,
  orderId: string,
  issueType: PaymentIssueType,
  comment?: string,
): Promise<ReportPaymentIssueResult> {
  const db = getDb();
  const order = await getOrderById(db, orderId);
  if (!order || order.userId !== userId) {
    return { ok: false, error: 'not_found', message: 'Заказ не найден.' };
  }
  // Пост-выпускной флоу осмыслен только для выполненного заказа (карта выпущена,
  // реквизиты отправлены) — иначе авторизованный клиент мог бы спамить события
  // на свои draft-заказы. UI и не показывает кнопку раньше completed.
  if (order.status !== 'completed') {
    return {
      ok: false,
      error: 'not_available',
      message: 'Эта кнопка станет доступна после выпуска карты по заказу.',
    };
  }

  try {
    // Дедуп: повторное нажатие в течение 5 минут не спамит оператора.
    const duplicate = await hasRecentOrderEvent(db, {
      orderId,
      eventType: PAYMENT_ISSUE_EVENT,
      withinMs: PAYMENT_ISSUE_DEDUP_MS,
    });
    if (duplicate) {
      return { ok: true, duplicate: true };
    }

    const [profile, service, card] = await Promise.all([
      getUserProfileById(db, userId),
      order.serviceId ? getServiceById(db, order.serviceId) : Promise.resolve(null),
      order.cardId ? findCardByIdForUser(db, order.cardId, userId) : Promise.resolve(null),
    ]);

    // Zod на границе jsonb: битые parameters не роняют жалобу — просто без тарифа.
    const parsedParams = orderParameters.safeParse(order.parameters ?? {});
    const tierName = parsedParams.success ? parsedParams.data.tierName ?? null : null;
    const operatorMessage = buildPaymentIssueOperatorMessage({
      telegramId,
      displayName: profile?.displayName ?? null,
      orderShortId: order.shortId,
      service: service?.name ?? order.customServiceDescription ?? 'Заказ вне каталога',
      tierName,
      amountKopecks: order.amountRub,
      cardStatusLabel: card ? CARD_STATUS_LABELS[card.status] : null,
      issueType,
      ...(comment !== undefined ? { comment } : {}),
    });

    const delivered = await sendToSupportOperator(operatorMessage, { orderId, issueType });
    if (!delivered) {
      return {
        ok: false,
        error: 'failed',
        message: 'Не получилось передать оператору. Попробуй ещё раз через пару минут.',
      };
    }

    await appendOrderEvent(db, {
      orderId,
      eventType: PAYMENT_ISSUE_EVENT,
      actorType: 'user',
      payload: { issueType },
    });

    return { ok: true, duplicate: false };
  } catch (err) {
    log.error({ event: 'cabinet.payment_issue.failed', orderId, err });
    Sentry.captureException(err, { tags: { source: 'cabinet.payment_issue' }, extra: { orderId } });
    return {
      ok: false,
      error: 'failed',
      message: 'Не получилось отправить. Попробуй ещё раз через минуту.',
    };
  }
}

// ─── «Проблема с оплатой» — фаза ДО выпуска карты (тикет 10) ──────────────

/** Окно дедупликации: новые типы порождают статусный переход и разбор оператором. */
const PAYMENT_PROBLEM_DEDUP_MS = 60 * 60 * 1000;

/** Свежесть «истёкшего» заказа, по которому ещё принимаем жалобу. */
const PAYMENT_PROBLEM_EXPIRED_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export type ReportPaymentProblemResult =
  | { ok: true; duplicate: boolean; text: string }
  | { ok: false; error: 'not_found' | 'not_available' | 'failed'; message: string };

const PAYMENT_PROBLEM_CLIENT_TEXT: Record<PaymentProblemType, string> = {
  not_confirmed:
    'Передали оператору — проверит в течение дня. Ускорит дело чек об оплате: пришли его в бота командой /support.',
  refund_request:
    'Передали оператору — он свяжется с тобой в Telegram. Возврат возможен, пока карта по заказу не выпущена.',
  other: 'Опиши проблему в боте командой /support — так оператор увидит её быстрее всего.',
};

/**
 * Клиент нажал «Проблема с оплатой» на экране заказа ДО выпуска карты.
 * «Я оплатил, но заказ не подтвердился» переводит заказ «на проверку» (актор
 * user) — он перестаёт тикать к протуханию; для «истёкшего» статус не трогаем
 * (переходов из expired нет и не добавляем) — только DM. Возврат — только
 * руками оператора, автоматики нет (Р8).
 */
export async function reportPaymentProblem(
  userId: string,
  telegramId: string | null,
  orderId: string,
  problemType: PaymentProblemType,
  comment?: string,
): Promise<ReportPaymentProblemResult> {
  const db = getDb();
  const order = await getOrderById(db, orderId);
  if (!order || order.userId !== userId) {
    return { ok: false, error: 'not_found', message: 'Заказ не найден.' };
  }
  const freshExpired =
    order.status === 'expired' &&
    order.expiresAt !== null &&
    Date.now() - order.expiresAt.getTime() <= PAYMENT_PROBLEM_EXPIRED_MAX_AGE_MS;
  const allowed =
    order.status === 'pending_payment' || order.status === 'payment_review' || freshExpired;
  if (!allowed) {
    return {
      ok: false,
      error: 'not_available',
      message: 'Эта кнопка работает, пока заказ ждёт оплату или платёж на проверке.',
    };
  }

  try {
    // «Другая проблема» — существующий флоу /support (спека §6.1, пункт 3):
    // подсказка без DM и событий — в боте оператор увидит описание сразу.
    if (problemType === 'other') {
      return { ok: true, duplicate: false, text: PAYMENT_PROBLEM_CLIENT_TEXT.other };
    }

    const duplicate = await hasRecentOrderEvent(db, {
      orderId,
      eventType: PAYMENT_PROBLEM_EVENT,
      withinMs: PAYMENT_PROBLEM_DEDUP_MS,
    });
    if (duplicate) {
      // Дедуп глушит только DM. Переход «на проверку» при «я оплатил» делаем и
      // здесь: «хочу возврат» → через 10 минут «я оплатил» не должен оставлять
      // заказ тикать к протуханию (находка ревью части 4).
      if (problemType === 'not_confirmed' && order.status === 'pending_payment') {
        try {
          await transitionOrder(db, {
            orderId,
            toStatus: 'payment_review',
            actorType: 'user',
            eventType: PAYMENT_PROBLEM_EVENT,
            payload: { problemType, reason: 'client_reported', duplicate: true },
          });
        } catch (err) {
          if (!(err instanceof OrderTransitionError)) throw err;
        }
      }
      return { ok: true, duplicate: true, text: PAYMENT_PROBLEM_CLIENT_TEXT[problemType] };
    }

    // Последний код провайдера (тикет 03) — оператору важно видеть, что там у
    // Freekassa (7 = холд, 0 = счёт даже не оплачивался).
    const payments = await findPaymentsByOrderId(db, orderId);
    const latestPayment = payments[0] ?? null;
    const [profile, service] = await Promise.all([
      getUserProfileById(db, userId),
      order.serviceId ? getServiceById(db, order.serviceId) : Promise.resolve(null),
    ]);

    // Доставка ПЕРВОЙ, записи после (как у соседнего reportPaymentIssue): если
    // событие-дедуп записать до сбоя доставки, ретрай клиента в течение часа
    // упирался бы в «обращение уже у оператора», которого оператор не получал
    // (находка ревью части 4).
    const operatorMessage = buildPaymentProblemOperatorMessage({
      telegramId,
      displayName: profile?.displayName ?? null,
      orderShortId: order.shortId,
      orderStatusLabel: ORDER_STATUS_LABELS[order.status],
      service: service?.name ?? order.customServiceDescription ?? 'Заказ вне каталога',
      amountKopecks: order.amountRub,
      lastProviderStatus: latestPayment?.lastProviderStatus ?? null,
      lastProviderStatusAt: latestPayment?.lastProviderStatusAt ?? null,
      problemType,
      ...(comment !== undefined ? { comment } : {}),
    });
    const delivered = await sendToSupportOperator(operatorMessage, { orderId, problemType });
    if (!delivered) {
      return {
        ok: false,
        error: 'failed',
        message: 'Не получилось передать оператору. Попробуй ещё раз через пару минут.',
      };
    }

    // «Я оплатил» из pending_payment → «на проверке банка»: перестаёт тикать к
    // протуханию. Переход пишет событие сам (append-only, инвариант 1); в
    // остальных случаях событие добавляется отдельной строкой.
    if (problemType === 'not_confirmed' && order.status === 'pending_payment') {
      try {
        await transitionOrder(db, {
          orderId,
          toStatus: 'payment_review',
          actorType: 'user',
          eventType: PAYMENT_PROBLEM_EVENT,
          payload: { problemType, reason: 'client_reported' },
        });
      } catch (err) {
        // Гонка с poll'ом (заказ уже «на проверке» или ушёл дальше) — обращение
        // уже у оператора; транзиентный сбой — наверх, в generic-ветку.
        if (!(err instanceof OrderTransitionError)) throw err;
        await appendOrderEvent(db, {
          orderId,
          eventType: PAYMENT_PROBLEM_EVENT,
          actorType: 'user',
          payload: { problemType, transitionSkipped: true },
        });
      }
    } else {
      await appendOrderEvent(db, {
        orderId,
        eventType: PAYMENT_PROBLEM_EVENT,
        actorType: 'user',
        payload: { problemType, orderStatus: order.status },
      });
    }

    return { ok: true, duplicate: false, text: PAYMENT_PROBLEM_CLIENT_TEXT[problemType] };
  } catch (err) {
    log.error({ event: 'cabinet.payment_problem.failed', orderId, err });
    Sentry.captureException(err, { tags: { source: 'cabinet.payment_problem' }, extra: { orderId } });
    return {
      ok: false,
      error: 'failed',
      message: 'Не получилось отправить. Попробуй ещё раз через минуту.',
    };
  }
}

// ─── «Подписка оплачена» — клиент подтвердил успех на сайте сервиса ────────

export type MarkSubscriptionActivatedResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'not_available' | 'failed'; message: string };

/**
 * Клиент отметил, что подписка на сайте сервиса оплачена (ТЗ §6). Пишем
 * append-only event — экран заказа показывает статус «Подписка оплачена».
 * Идемпотентно: повторное нажатие не плодит события.
 */
export async function markSubscriptionActivated(
  userId: string,
  orderId: string,
): Promise<MarkSubscriptionActivatedResult> {
  const db = getDb();
  const order = await getOrderById(db, orderId);
  if (!order || order.userId !== userId) {
    return { ok: false, error: 'not_found', message: 'Заказ не найден.' };
  }
  // Тот же гейт, что у reportPaymentIssue: события «после карты» — только для
  // выполненного заказа.
  if (order.status !== 'completed') {
    return {
      ok: false,
      error: 'not_available',
      message: 'Эта кнопка станет доступна после выпуска карты по заказу.',
    };
  }

  try {
    const already = await hasRecentOrderEvent(db, {
      orderId,
      eventType: SUBSCRIPTION_ACTIVATED_EVENT,
      // «Когда-либо» — событие достаточно одно; год покрывает жизнь заказа.
      withinMs: 365 * 24 * 60 * 60 * 1000,
    });
    if (!already) {
      await appendOrderEvent(db, {
        orderId,
        eventType: SUBSCRIPTION_ACTIVATED_EVENT,
        actorType: 'user',
      });
    }
    return { ok: true };
  } catch (err) {
    log.error({ event: 'cabinet.subscription_activated.failed', orderId, err });
    Sentry.captureException(err, {
      tags: { source: 'cabinet.subscription_activated' },
      extra: { orderId },
    });
    return {
      ok: false,
      error: 'failed',
      message: 'Не получилось сохранить. Попробуй ещё раз через минуту.',
    };
  }
}

