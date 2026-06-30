import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { findOrdersMissingReferralAccruals, getDb } from '@oplati/db';

import { serverEnv } from '../env.ts';
import { childLogger } from '../logger.ts';
import { accrueReferralForPayment } from '../referral/accrue.ts';

const log = childLogger('cron.referral-recovery');

/** Сколько заказов добираем за один запуск (бэкстоп, объёмы малы). */
const RECOVERY_LIMIT = 100;

/**
 * Cron `referral-recovery` (бэкстоп Этапа B): досчитывает реферальные начисления
 * для заказов, где основной inline-путь в `processInvoicePaid` не отработал (БД
 * упала в момент webhook). Находит заказы paid+ с реферером и успешным платежом,
 * но без строк начисления, и зовёт `accrueReferralForPayment` (идемпотентно +
 * graceful). Гейт `REFERRAL_ENABLED`.
 */
export async function recoverReferralAccruals(): Promise<{
  scanned: number;
  processed: number;
  errors: number;
}> {
  if (!serverEnv.REFERRAL_ENABLED) {
    log.info({ event: 'cron.referral_recovery.skipped_disabled' });
    return { scanned: 0, processed: 0, errors: 0 };
  }

  log.info({ event: 'cron.referral_recovery.start' });
  const db = getDb();
  const orders = await findOrdersMissingReferralAccruals(db, RECOVERY_LIMIT);

  let processed = 0;
  let errors = 0;
  for (const o of orders) {
    try {
      // accrueReferralForPayment graceful внутри, но оборачиваем на случай
      // неожиданного — один битый заказ не должен валить весь прогон.
      await accrueReferralForPayment({ orderId: o.orderId, paymentId: o.paymentId });
      processed++;
    } catch (err) {
      errors++;
      log.error({ event: 'cron.referral_recovery.order_error', orderId: o.orderId, err });
      Sentry.captureException(err, { tags: { source: 'cron.referral-recovery' } });
    }
  }

  log.info({ event: 'cron.referral_recovery.done', scanned: orders.length, processed, errors });
  return { scanned: orders.length, processed, errors };
}
