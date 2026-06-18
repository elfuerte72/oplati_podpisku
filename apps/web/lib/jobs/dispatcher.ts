import 'server-only';

import { after } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import { childLogger } from '../logger.ts';
import { issueCard } from './issue-card.ts';
import { notifyPaymentConfirmed } from './notify-payment.ts';

/**
 * Диспатч background-job'ов после ответа webhook'а/cron'а.
 *
 * Используем `after()` из `next/server` (под капотом — платформенный
 * `waitUntil`): Vercel ДЕРЖИТ инстанс живым до завершения колбэка. Это
 * принципиально отличается от прежнего `setImmediate` (fire-and-forget): тот
 * не отслеживался платформой, и инстанс мог замёрзнуть сразу после `200 OK`,
 * не доделав выпуск карты / уведомление (наблюдали вживую — заказ зависал в
 * `paid` без карты и без сообщения в Telegram).
 *
 * Контракт: оба `dispatch*` вызываются синхронно из тела route-handler'а
 * (webhook `/api/payments/loveandpay` и cron `/api/cron/poll-payment` через
 * `processInvoicePaid`), т.е. в request-scope — `after()` там валиден.
 *
 * Подстраховка от потери всё равно остаётся: cron `poll-payment`
 * (findStuckPaidOrders) повторно прогоняет issue-card для заказов, зависших в
 * `paid`. Повтор безопасен — issueCard атомарно claim'ит paid → in_fulfillment.
 */

const log = childLogger('jobs.dispatcher');

export function dispatchIssueCard(orderId: string): void {
  log.info({ event: 'jobs.dispatch.issue_card', orderId });
  after(async () => {
    try {
      await issueCard(orderId);
    } catch (err) {
      log.error({ event: 'jobs.dispatch.issue_card.failed', orderId, err });
      Sentry.captureException(err, {
        tags: { source: 'jobs.dispatcher', job: 'issue_card' },
        extra: { orderId },
      });
    }
  });
}

export function dispatchPaymentConfirmed(orderId: string): void {
  log.info({ event: 'jobs.dispatch.payment_confirmed', orderId });
  after(async () => {
    // notifyPaymentConfirmed сам не бросает, но try/catch на всякий случай.
    try {
      await notifyPaymentConfirmed(orderId);
    } catch (err) {
      log.error({ event: 'jobs.dispatch.payment_confirmed.failed', orderId, err });
      Sentry.captureException(err, {
        tags: { source: 'jobs.dispatcher', job: 'payment_confirmed' },
        extra: { orderId },
      });
    }
  });
}
