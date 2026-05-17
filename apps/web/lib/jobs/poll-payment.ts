import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { findPendingPaymentsForPoll, getDb } from '@oplati/db';

import { childLogger } from '../logger.ts';
import { getLoveAndPayClient } from '../loveandpay/index.ts';
import {
  loveAndPayTerminalReason,
  processInvoicePaid,
  processInvoiceTerminal,
} from '../loveandpay/handlers.ts';

/**
 * Cron `poll-payment` — подстраховка от потерянных L&P-webhook'ов.
 *
 * Каждые 5 минут (см. vercel.ts → crons) проверяем все pending платежи,
 * старше 10 минут и не древнее 25 часов (TTL invoice'а — 24h).
 * Если статус сменился в L&P — повторно вызываем те же handler'ы, что webhook,
 * с `recoveredViaPolling=true` для трассировки и Sentry warning.
 */

const log = childLogger('cron.poll-payment');

export async function pollPayments(): Promise<{
  processed: number;
  recovered: number;
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

  log.info({
    event: 'cron.poll_payment.done',
    processed: pending.length,
    recovered,
    errors,
  });

  return { processed: pending.length, recovered, errors };
}
