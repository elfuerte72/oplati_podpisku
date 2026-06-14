import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { findPendingPaymentsForPoll, findStuckPaidOrders, getDb } from '@oplati/db';

import { childLogger } from '../logger.ts';
import { isPaySpaceConfigured } from '../pay-space/index.ts';
import { getLoveAndPayClient } from '../loveandpay/index.ts';
import {
  loveAndPayTerminalReason,
  processInvoicePaid,
  processInvoiceTerminal,
} from '../loveandpay/handlers.ts';
import { issueCard } from './issue-card.ts';

/**
 * Cron `poll-payment` — подстраховка от потерянных L&P-webhook'ов И от
 * потерянного issue-card (fire-and-forget через setImmediate не переживает
 * cold-shutdown инстанса).
 *
 * Каждые 5 минут (см. apps/web/vercel.json → crons):
 *   1. Проверяем pending платежи (старше 10 мин, не древнее 25 ч): если статус
 *      сменился в L&P — повторяем handler'ы (recoveredViaPolling=true).
 *   2. Recovery fulfillment: заказы, зависшие в `paid` дольше порога, повторно
 *      прогоняем через issue-card (идемпотентно — claim защищает от двойного
 *      топ-апа). Только когда PaySpace настроен: иначе `paid` — это намеренное
 *      состояние для ручного fulfillment, дёргать нечего.
 */

const log = childLogger('cron.poll-payment');

// Заказ в `paid` дольше этого порога считаем «issue-card потерян» (нормальный
// выпуск стартует через setImmediate в пределах секунд после оплаты).
const STUCK_PAID_THRESHOLD_MS = 10 * 60 * 1000;

export async function pollPayments(): Promise<{
  processed: number;
  recovered: number;
  refulfilled: number;
  errors: number;
}> {
  log.info({ event: 'cron.poll_payment.start' });

  const db = getDb();
  const pending = await findPendingPaymentsForPoll(db);

  log.info({ event: 'cron.poll_payment.found', count: pending.length });

  let recovered = 0;
  let errors = 0;
  const client = getLoveAndPayClient();

  for (const payment of pending) {
    if (payment.provider !== 'loveandpay') continue;

    try {
      const invoice = await client.getInvoice(payment.providerRef);
      if (invoice.status === 'PAID') {
        await processInvoicePaid({
          data: {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            amount: invoice.amount,
            currency: invoice.currency,
            status: invoice.status,
          },
          rawPayload: invoice as unknown as Record<string, unknown>,
          recoveredViaPolling: true,
        });
        recovered++;
        Sentry.captureMessage('L&P payment recovered via polling — webhook потерян', {
          level: 'warning',
          tags: { source: 'cron.poll-payment' },
          extra: { paymentId: payment.id, invoiceId: invoice.id },
        });
      } else {
        const reason = loveAndPayTerminalReason(invoice.status);
        if (reason) {
          await processInvoiceTerminal({
            data: {
              id: invoice.id,
              invoiceNumber: invoice.invoiceNumber,
              amount: invoice.amount,
              currency: invoice.currency,
              status: invoice.status,
            },
            reason,
          });
        }
      }
    } catch (err) {
      errors++;
      log.error({ event: 'cron.poll_payment.error', paymentId: payment.id, err });
      Sentry.captureException(err, {
        tags: { source: 'cron.poll-payment' },
        extra: { paymentId: payment.id, providerRef: payment.providerRef },
      });
    }
  }

  // Recovery потерянного issue-card: заказы, зависшие в `paid`. Идемпотентно —
  // issueCard claim'ит paid → in_fulfillment атомарно, повторный прогон не
  // пополняет карту дважды. Только при настроенном PaySpace.
  let refulfilled = 0;
  if (isPaySpaceConfigured()) {
    try {
      const stuck = await findStuckPaidOrders(db, { olderThanMs: STUCK_PAID_THRESHOLD_MS });
      if (stuck.length > 0) {
        log.warn({ event: 'cron.poll_payment.stuck_paid_found', count: stuck.length });
        Sentry.captureMessage('Заказы зависли в paid — повторный issue-card', {
          level: 'warning',
          tags: { source: 'cron.poll-payment' },
          extra: { count: stuck.length },
        });
        for (const order of stuck) {
          try {
            // Внутри cron (maxDuration=300) ждём завершения — детерминированнее
            // fire-and-forget. issueCard сам ловит свои ошибки (markOrderFailed).
            await issueCard(order.id);
            refulfilled++;
          } catch (err) {
            errors++;
            log.error({ event: 'cron.poll_payment.refulfill_error', orderId: order.id, err });
            Sentry.captureException(err, {
              tags: { source: 'cron.poll-payment', step: 'refulfill' },
              extra: { orderId: order.id },
            });
          }
        }
      }
    } catch (err) {
      errors++;
      log.error({ event: 'cron.poll_payment.stuck_query_error', err });
      Sentry.captureException(err, { tags: { source: 'cron.poll-payment', step: 'stuck_query' } });
    }
  }

  log.info({
    event: 'cron.poll_payment.done',
    processed: pending.length,
    recovered,
    refulfilled,
    errors,
  });

  return { processed: pending.length, recovered, refulfilled, errors };
}
