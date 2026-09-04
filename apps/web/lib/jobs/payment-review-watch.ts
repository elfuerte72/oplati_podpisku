import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { findStaleOrdersInPaymentReview, getDb } from '@oplati/db';

import { DedupWindow } from '../alerts/dedup-window.ts';
import { notifyOps } from '../alerts/notify-ops.ts';
import { childLogger } from '../logger.ts';

/**
 * Предохранитель от вечного «на проверке банка» (антифрод-трек, тикет 04):
 * заказ в `payment_review` дольше 7 дней — DM владельцу, БЕЗ автозакрытия.
 * Автомат здесь опасен: у клиента, возможно, списаны деньги, и закрыть заказ
 * по таймеру значит потерять их след — исход решает провайдер/оператор.
 *
 * Вызывается из cron `poll-payment` (каждые 5 минут); сам ловит свои ошибки —
 * сторож не должен ронять добор платежей.
 */

const log = childLogger('payment-review-watch');

const STALE_REVIEW_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

// Дедуп DM по заказу: залипший заказ живёт до вмешательства человека, и без
// окна владелец получал бы сообщение каждые 5 минут. Сутки — достаточно редко,
// чтобы не заспамить, и достаточно часто, чтобы не забыть.
const staleReviewDedup = new DedupWindow(24 * 60 * 60 * 1000);

/** Только для unit-тестов — сбрасывает окно дедупа DM. */
export function resetStaleReviewAlertDedupForTests(): void {
  staleReviewDedup.resetForTests();
}

export async function alertOnStalePaymentReview(): Promise<void> {
  try {
    const stale = await findStaleOrdersInPaymentReview(getDb(), {
      olderThanMs: STALE_REVIEW_THRESHOLD_MS,
    });
    if (stale.length === 0) return;

    log.error({
      event: 'cron.poll_payment.stale_payment_review',
      count: stale.length,
      orderIds: stale.map((o) => o.id),
    });

    for (const order of stale) {
      // Sentry и DM — под одним дедупом: без него крон каждые 5 минут слал бы
      // событие о том же залипшем заказе (лог выше остаётся на каждый прогон —
      // он дёшев и нужен разбору по LogQL).
      if (!staleReviewDedup.shouldSend(order.id)) continue;
      Sentry.captureMessage('Заказ висит в payment_review дольше 7 дней', {
        level: 'error',
        tags: { source: 'payment-review-watch', alert: 'stale_payment_review' },
        extra: { orderId: order.id, shortId: order.shortId },
      });
      await notifyOps(
        `Заказ ${order.shortId} висит «на проверке банка» дольше 7 дней ` +
          `(сумма ${((order.amountRub ?? 0) / 100).toFixed(2)} ₽). Автозакрытия нет — ` +
          `нужен запрос в поддержку Freekassa: подтвердят оплату или вернут деньги отправителю.`,
        { stream: 'payments', title: 'На проверке банка дольше 7 дней', action: { text: 'написать в поддержку Freekassa', path: '/admin/holds' } },
      );
    }
  } catch (err) {
    log.error({ event: 'cron.poll_payment.stale_review_check_failed', err });
    Sentry.captureException(err, {
      tags: { source: 'cron.poll-payment', step: 'stale_review' },
    });
  }
}
