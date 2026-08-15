import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  appendOrderEvent,
  findCardByIdForUser,
  findPendingPaymentByOrderId,
  getDb,
  getOrderById,
  getOrCreateActiveConversation,
  getServiceById,
  getUserProfileById,
  hasRecentOrderEvent,
} from '@oplati/db';
import { orderParameters } from '@oplati/types';

import { EMAIL_REQUIRED_TEXT } from '../contacts/email.ts';
import { childLogger } from '../logger.ts';
import { PROVIDER_UNAVAILABLE_TEXT } from '../loveandpay/availability.ts';
import {
  confirmOrder,
  aboveMaxAmountText,
  EmailRequiredError,
  OrderAboveMaxAmountError,
  OrderExpiredError,
  PaymentProviderUnavailableError,
  TelegramLinkRequiredError,
} from '../tool-handlers/confirm-order.ts';
import { proposeFromCatalog } from '../catalog/propose.ts';
import { buildPaymentIssueOperatorMessage } from '../telegram/templates.ts';
import { sendToSupportOperator } from '../telegram/support.ts';
import type { PaymentIssueType } from './payment-issues.ts';
import {
  CARD_STATUS_LABELS,
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
        | 'failed';
      message: string;
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
    log.error({ event: 'cabinet.pay.failed', orderId, err });
    Sentry.captureException(err, { tags: { source: 'cabinet.pay' }, extra: { orderId } });
    return {
      ok: false,
      error: 'failed',
      message: 'Не получилось создать счёт. Попробуй ещё раз через минуту.',
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

