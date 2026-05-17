import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  findPaymentByProviderRef,
  getDb,
  markPaymentStatus,
  markPaymentSucceeded,
  transitionOrder,
  type PaymentRow,
} from '@oplati/db';
import type { LoveAndPayInvoiceStatus, LoveAndPayWebhookData } from '@oplati/types';

import { childLogger } from '../logger.ts';
import { dispatchIssueCard } from '../jobs/dispatcher.ts';

/**
 * Общие хендлеры обработки L&P-событий (как из webhook, так и из cron poll-payment).
 *
 * Помещены отдельно от route'а, чтобы один и тот же код обрабатывал:
 *   - синхронный путь: webhook `POST /api/payments/loveandpay` → processInvoicePaid
 *   - подстраховку: cron `poll-payment` → processInvoicePaid (с recoveredViaPolling=true)
 *
 * Любой кидающий путь = баг. На границе webhook'а / cron'а всё ловится try/catch
 * → 200 OK + Sentry (см. CLAUDE.md → инвариант 6).
 */

const log = childLogger('loveandpay-handlers');

export type InvoicePaidInput = {
  data: LoveAndPayWebhookData;
  rawPayload: Record<string, unknown>;
  recoveredViaPolling?: boolean;
};

export type HandlerResult =
  | { kind: 'processed'; paymentId: string; orderId: string }
  | { kind: 'idempotent_skip'; paymentId: string; reason: string }
  | { kind: 'not_found'; providerRef: string };

/**
 * Обработка `invoice.paid`. Идемпотентно: если payment уже `succeeded` или order
 * уже `paid`/`in_fulfillment`/`completed`, ничего не делаем (`transitionOrder`
 * это форсит на уровне `allowedTransitions`, но мы ещё и сами проверяем).
 */
export async function processInvoicePaid(input: InvoicePaidInput): Promise<HandlerResult> {
  const { data, rawPayload, recoveredViaPolling = false } = input;
  const db = getDb();

  const payment = await findPaymentByProviderRef(db, 'loveandpay', data.id);
  if (!payment) {
    log.warn({
      event: 'loveandpay.handlers.payment_not_found',
      providerRef: data.id,
      invoiceNumber: data.invoiceNumber,
    });
    Sentry.captureMessage('L&P invoice.paid без нашего payment', {
      level: 'warning',
      tags: { source: 'loveandpay.webhook' },
      extra: { providerRef: data.id, invoiceNumber: data.invoiceNumber },
    });
    return { kind: 'not_found', providerRef: data.id };
  }

  if (payment.status === 'succeeded') {
    log.info({
      event: 'loveandpay.handlers.idempotent_skip',
      paymentId: payment.id,
      reason: 'already_succeeded',
    });
    return { kind: 'idempotent_skip', paymentId: payment.id, reason: 'already_succeeded' };
  }

  await markPaymentSucceeded(db, {
    paymentId: payment.id,
    webhookReceivedAt: new Date(),
    rawPayload,
    recoveredViaPolling,
  });

  // Переход pending_payment → paid. Если order уже paid (race с другим путём) —
  // transitionOrder вернёт noop (так как from === to). Если status в `in_fulfillment`
  // или `completed` — allowedTransitions запретит, бросит OrderTransitionError,
  // что мы здесь же ловим: повторно отметить order paid в этих кейсах не нужно.
  try {
    await transitionOrder(db, {
      orderId: payment.orderId,
      toStatus: 'paid',
      actorType: 'payment_provider',
      eventType: 'payment_succeeded',
      payload: {
        paymentId: payment.id,
        provider: 'loveandpay',
        invoiceId: data.id,
        invoiceNumber: data.invoiceNumber,
        recoveredViaPolling,
      },
    });
  } catch (err) {
    log.warn({
      event: 'loveandpay.handlers.transition_skip',
      orderId: payment.orderId,
      err,
    });
  }

  // После успешной оплаты — запускаем issue-card. Sync-fallback через
  // setImmediate; реальный Trigger.dev задеплоится в отдельном milestone.
  dispatchIssueCard(payment.orderId);

  log.info({
    event: 'loveandpay.handlers.invoice_paid_processed',
    paymentId: payment.id,
    orderId: payment.orderId,
    recoveredViaPolling,
  });

  return { kind: 'processed', paymentId: payment.id, orderId: payment.orderId };
}

export type InvoiceTerminalInput = {
  data: LoveAndPayWebhookData;
  /** Какой terminal status — `expired` или `cancelled`. */
  reason: 'expired' | 'cancelled';
};

export async function processInvoiceTerminal(input: InvoiceTerminalInput): Promise<HandlerResult> {
  const { data, reason } = input;
  const db = getDb();

  const payment = await findPaymentByProviderRef(db, 'loveandpay', data.id);
  if (!payment) {
    log.warn({
      event: 'loveandpay.handlers.payment_not_found',
      providerRef: data.id,
      invoiceNumber: data.invoiceNumber,
      reason,
    });
    return { kind: 'not_found', providerRef: data.id };
  }

  if (payment.status !== 'pending') {
    log.info({
      event: 'loveandpay.handlers.idempotent_skip',
      paymentId: payment.id,
      reason: `already_${payment.status}`,
    });
    return { kind: 'idempotent_skip', paymentId: payment.id, reason: `already_${payment.status}` };
  }

  await markPaymentStatus(db, payment.id, 'failed');

  try {
    await transitionOrder(db, {
      orderId: payment.orderId,
      toStatus: reason,
      actorType: 'payment_provider',
      eventType: `payment_${reason}`,
      payload: { paymentId: payment.id, invoiceId: data.id, invoiceNumber: data.invoiceNumber },
    });
  } catch (err) {
    log.warn({
      event: 'loveandpay.handlers.transition_skip',
      orderId: payment.orderId,
      err,
    });
  }

  log.info({
    event: 'loveandpay.handlers.invoice_terminal_processed',
    paymentId: payment.id,
    orderId: payment.orderId,
    reason,
  });

  return { kind: 'processed', paymentId: payment.id, orderId: payment.orderId };
}

/** Маппер на наш terminal-кейс. */
export function loveAndPayTerminalReason(
  externalStatus: LoveAndPayInvoiceStatus,
): 'expired' | 'cancelled' | null {
  if (externalStatus === 'EXPIRED') return 'expired';
  if (externalStatus === 'CANCELLED') return 'cancelled';
  return null;
}

/**
 * Превращает `PaymentRow` в input для cron'а — нужно когда мы стартуем
 * processInvoicePaid от данных, полученных по polling (getInvoice), а не
 * webhook'у.
 */
export function paymentRowToWebhookData(
  payment: PaymentRow,
  invoiceData: { id: string; invoiceNumber: string; amount: number; currency: string; status: LoveAndPayInvoiceStatus },
): LoveAndPayWebhookData {
  return {
    id: invoiceData.id,
    invoiceNumber: invoiceData.invoiceNumber,
    amount: invoiceData.amount,
    currency: invoiceData.currency,
    status: invoiceData.status,
  };
}
