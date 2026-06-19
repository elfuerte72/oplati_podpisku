import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  getDb,
  getOrderById,
  getOrCreateActiveConversation,
  getServiceById,
  findPaymentsByOrderId,
} from '@oplati/db';
import type { OrderParameters } from '@oplati/types';

import { childLogger } from '../logger.ts';
import { confirmOrder, TelegramLinkRequiredError } from '../tool-handlers/confirm-order.ts';
import { requestHuman } from '../tool-handlers/request-human.ts';
import { proposeFromCatalog } from '../catalog/propose.ts';
import { isPayableStatus } from './types.ts';

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
      error: 'not_found' | 'not_payable' | 'invoice_unavailable' | 'link_required' | 'failed';
      message: string;
    };

/** Достаёт платёжную ссылку из сохранённого invoice (для уже выставленного счёта). */
function extractInvoiceLink(
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
  if (!isPayableStatus(order.status)) {
    return {
      ok: false,
      error: 'not_payable',
      message: 'Этот заказ уже нельзя оплатить — он не ждёт оплаты.',
    };
  }

  // Счёт уже выставлен (pending_payment) — отдаём существующую ссылку, не плодим
  // второй invoice. `/api/payments/create` всё равно отверг бы повторный вызов (409).
  if (order.status === 'pending_payment') {
    const payments = await findPaymentsByOrderId(db, orderId);
    for (const payment of payments) {
      const link = extractInvoiceLink(payment.rawPayload);
      if (link) return { ok: true, ...link };
    }
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
    log.error({ event: 'cabinet.pay.failed', orderId, err });
    Sentry.captureException(err, { tags: { source: 'cabinet.pay' }, extra: { orderId } });
    return {
      ok: false,
      error: 'failed',
      message: 'Не получилось создать счёт. Попробуй ещё раз через минуту.',
    };
  }
}

// ─── Повторить заказ ──────────────────────────────────────────────────────

export type RepeatOrderResult =
  | {
      ok: true;
      orderId: string;
      shortId: string;
      service: string;
      totalKopecks: number;
      expiresAt: string;
    }
  | {
      ok: false;
      error: 'not_found' | 'cannot_repeat_custom' | 'service_unavailable' | 'failed';
      message: string;
    };

export async function repeatOrder(userId: string, orderId: string): Promise<RepeatOrderResult> {
  const db = getDb();
  const order = await getOrderById(db, orderId);
  if (!order || order.userId !== userId) {
    return { ok: false, error: 'not_found', message: 'Заказ не найден.' };
  }
  if (!order.serviceId) {
    return {
      ok: false,
      error: 'cannot_repeat_custom',
      message: 'Этот заказ был вне каталога — напиши в чат, оформим заново через оператора.',
    };
  }

  const service = await getServiceById(db, order.serviceId);
  if (!service || !service.isActive) {
    return {
      ok: false,
      error: 'service_unavailable',
      message: 'Этот сервис сейчас недоступен. Выбери другой в чате.',
    };
  }

  const params = (order.parameters ?? {}) as OrderParameters;
  const tierName = params.tierName;
  // Для custom-amount сервисов сумма берётся из исходного заказа (USD-центы).
  const amountUsdCents = order.originalAmount ?? undefined;

  try {
    const conversation = await getOrCreateActiveConversation(
      db,
      { userId, channel: 'telegram' },
      dbLog,
    );
    const result = await proposeFromCatalog({
      userId,
      conversationId: conversation.id,
      channel: 'telegram',
      slug: service.slug,
      ...(tierName !== undefined ? { tierName } : {}),
      ...(amountUsdCents !== undefined ? { amountUsdCents } : {}),
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
    log.error({ event: 'cabinet.repeat.failed', orderId, err });
    Sentry.captureException(err, { tags: { source: 'cabinet.repeat' }, extra: { orderId } });
    return {
      ok: false,
      error: 'failed',
      message: 'Не получилось повторить заказ. Попробуй ещё раз или напиши в чат.',
    };
  }
}

// ─── Запросить оператора ──────────────────────────────────────────────────

export type RequestOperatorResult =
  | { ok: true; slaHours: number; withinBusinessHours: boolean; duplicate: boolean }
  | { ok: false; error: 'not_found' | 'failed'; message: string };

export async function requestOperator(
  userId: string,
  orderId: string,
): Promise<RequestOperatorResult> {
  const db = getDb();
  const order = await getOrderById(db, orderId);
  if (!order || order.userId !== userId) {
    return { ok: false, error: 'not_found', message: 'Заказ не найден.' };
  }

  try {
    const conversation = await getOrCreateActiveConversation(
      db,
      { userId, channel: 'telegram' },
      dbLog,
    );
    const result = await requestHuman({
      orderId,
      reason: 'Запрос оператора из личного кабинета (Mini App)',
      userId,
      conversationId: conversation.id,
    });
    return {
      ok: true,
      slaHours: result.slaHours,
      withinBusinessHours: result.withinBusinessHours,
      duplicate: result.duplicate ?? false,
    };
  } catch (err) {
    log.error({ event: 'cabinet.operator.failed', orderId, err });
    Sentry.captureException(err, { tags: { source: 'cabinet.operator' }, extra: { orderId } });
    return {
      ok: false,
      error: 'failed',
      message: 'Не получилось отправить заявку. Попробуй ещё раз через минуту.',
    };
  }
}
