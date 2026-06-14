import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { childLogger } from '../logger.ts';
import { issueCard } from './issue-card.ts';
import { notifyPaymentConfirmed } from './notify-payment.ts';

/**
 * Диспатч background-job'ов. Сегодня — sync-fallback (Trigger.dev не подключён;
 * план MVP Task 6.1 помечает это как known risk и допускает sync). Когда
 * Trigger.dev появится — заменим тело на `await client.sendEvent({ name, payload })`.
 *
 * Sync-режим: запускаем job через `setImmediate` (fire-and-forget). Webhook
 * успевает ответить 200 OK, а job идёт в background внутри того же Fluid Compute
 * instance. Это не гарантирует завершение при cold-shutdown'е инстанса.
 *
 * Подстраховка от потери: cron `poll-payment` (lib/jobs/poll-payment.ts) ищет
 * заказы, зависшие в `paid` (findStuckPaidOrders), и повторно прогоняет
 * issue-card. Повтор безопасен — issueCard claim'ит paid → in_fulfillment
 * атомарно (transitionOrderDetailed), двойного топ-апа не будет.
 */

const log = childLogger('jobs.dispatcher');

export function dispatchIssueCard(orderId: string): void {
  log.info({ event: 'jobs.dispatch.issue_card', orderId });
  // setImmediate — поток управления возвращается в webhook сразу.
  setImmediate(() => {
    issueCard(orderId).catch((err) => {
      log.error({ event: 'jobs.dispatch.issue_card.failed', orderId, err });
      Sentry.captureException(err, {
        tags: { source: 'jobs.dispatcher', job: 'issue_card' },
        extra: { orderId },
      });
    });
  });
}

export function dispatchPaymentConfirmed(orderId: string): void {
  log.info({ event: 'jobs.dispatch.payment_confirmed', orderId });
  setImmediate(() => {
    // notifyPaymentConfirmed сам не бросает, но .catch на всякий случай.
    notifyPaymentConfirmed(orderId).catch((err) => {
      log.error({ event: 'jobs.dispatch.payment_confirmed.failed', orderId, err });
      Sentry.captureException(err, {
        tags: { source: 'jobs.dispatcher', job: 'payment_confirmed' },
        extra: { orderId },
      });
    });
  });
}
