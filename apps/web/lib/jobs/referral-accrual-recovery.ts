import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  findOrdersMissingReferralAccruals,
  findOrdersWithUnreversedAccruals,
  getDb,
  reverseAccrualsForOrder,
} from '@oplati/db';

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
 * graceful). Эта половина под гейтом `REFERRAL_ENABLED`.
 *
 * Вторая половина (R-1.7) — сверка в обратную сторону: заказ провалился или
 * возвращён, а начисление по нему живо. Идёт ВСЕГДА, независимо от флага.
 */
export async function recoverReferralAccruals(): Promise<{
  scanned: number;
  processed: number;
  errors: number;
  reversed: number;
}> {
  // ⚠️ Гейт флага стоит ТОЛЬКО на доборе начислений. Сверка отмен идёт всегда:
  // `REFERRAL_ENABLED` — аварийный выключатель программы, и если его дёрнули,
  // начисления, записанные при включённом, продолжали бы висеть на балансе по
  // провалившимся заказам (находка ревью — та же логика, по которой гейт снят с
  // самой отмены). Гасить безопасно всегда: это только уменьшает обязательства.
  const accrualsEnabled = serverEnv.REFERRAL_ENABLED;
  if (!accrualsEnabled) {
    log.info({ event: 'cron.referral_recovery.accruals_skipped_disabled' });
  }

  log.info({ event: 'cron.referral_recovery.start' });
  const db = getDb();
  const orders = accrualsEnabled
    ? await findOrdersMissingReferralAccruals(db, RECOVERY_LIMIT)
    : [];

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

  // Вторая половина сверки (R-1.7): расхождение в обратную сторону — заказ
  // провалился, а начисление по нему живо. Inline-вызовов отмены несколько
  // (фулфилмент, недоплата у обоих шлюзов), и забытая точка перехода в `failed`
  // означала бы молча завышенный баланс партнёра — тот же баг, только в новом
  // месте. Считается отдельно от `processed`: это не добор, а гашение.
  //
  // Зовём репозиторий НАПРЯМУЮ, а не graceful-обёртку inline-путей: та по
  // контракту не бросает (сбой → Sentry + 0), и здесь это стирало бы разницу
  // между «гасить было нечего» и «БД лежит» — крон отчитывался бы `errors: 0`
  // при сломанном ledger'е (находка ревью). Обёртка нужна там, где исключение
  // сорвало бы перевод заказа в failed; у крона такой опасности нет.
  let reversed = 0;
  let reversedOrders = 0;
  const stale = await findOrdersWithUnreversedAccruals(db, RECOVERY_LIMIT);
  for (const orderId of stale) {
    try {
      reversed += await reverseAccrualsForOrder(db, orderId);
      reversedOrders++;
    } catch (err) {
      errors++;
      log.error({ event: 'cron.referral_recovery.reverse_error', orderId, err });
      Sentry.captureException(err, { tags: { source: 'cron.referral-recovery' } });
    }
  }
  if (stale.length > 0) {
    // Не рутина: в норме inline-путь гасит сам, и сюда попадает только то, что
    // он пропустил. Видимость важнее тишины — иначе дыра живёт незамеченной.
    // Единицы разные и названы явно: `staleOrders` — заказы, `reversedRows` —
    // строки ledger'а (у заказа их может быть несколько), иначе «reversed > orders»
    // читалось бы как двойное гашение.
    log.warn({
      event: 'cron.referral_recovery.stale_accruals',
      staleOrders: stale.length,
      reversedOrders,
      reversedRows: reversed,
    });
  }

  log.info({
    event: 'cron.referral_recovery.done',
    scanned: orders.length,
    processed,
    errors,
    reversed,
  });
  return { scanned: orders.length, processed, errors, reversed };
}
