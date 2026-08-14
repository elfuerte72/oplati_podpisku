import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  findNegativeReferralBalances,
  findOrdersMissingReferralAccruals,
  findOrdersWithUnreversedAccruals,
  findPurchasedOrdersWithReversedAccruals,
  getDb,
  reverseAccrualsForOrder,
  type UnreversedAccrualOrder,
} from '@oplati/db';

import { serverEnv } from '../env.ts';
import { childLogger } from '../logger.ts';
import { notifyOps } from '../alerts/notify-ops.ts';
import { accrueReferralForPayment } from '../referral/accrue.ts';

const log = childLogger('cron.referral-recovery');

/** Сколько заказов добираем за один запуск (бэкстоп, объёмы малы). */
const RECOVERY_LIMIT = 100;

// Дедуп DM (тот же приём, что у proxy-health и payment-conversion). Крон бежит
// ежечасно, а расхождение живёт до вмешательства человека: без дедупа владелец
// получал бы одно и то же сообщение бесконечно, и денежный алерт стал бы фоном.
// Sentry группирует сам, личка — нет.
const OPS_DM_DEDUP_MS = 60 * 60 * 1000;
let lastStaleDmAt = 0;
let lastNegativeDmAt = 0;
let lastUnderpaidDmAt = 0;

/** Только для unit-тестов — сбрасывает окна дедупа DM. */
export function resetReferralRecoveryAlertDedupForTests(): void {
  lastStaleDmAt = 0;
  lastNegativeDmAt = 0;
  lastUnderpaidDmAt = 0;
}

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
  //
  // Сама ВЫБОРКА тоже под перехватом (находка QA): она стояла голой, и её сбой
  // ронял весь прогон вместе с двумя проверками, которые идут ниже, — то есть
  // одна упавшая выборка гасила все денежные сигналы разом.
  let reversed = 0;
  let reversedOrders = 0;
  let stale: UnreversedAccrualOrder[] = [];
  try {
    stale = await findOrdersWithUnreversedAccruals(db, RECOVERY_LIMIT);
  } catch (err) {
    errors++;
    log.error({ event: 'cron.referral_recovery.stale_select_error', err });
    Sentry.captureException(err, { tags: { source: 'cron.referral-recovery' } });
  }
  for (const { orderId } of stale) {
    try {
      const rows = await reverseAccrualsForOrder(db, orderId);
      reversed += rows;
      // Считаем заказ погашенным только если строки реально записаны: ноль
      // означает проигрыш гонки inline-пути (ON CONFLICT DO NOTHING), и
      // «reversedOrders: 5, reversedRows: 0» читалось бы как пять отмен.
      if (rows > 0) reversedOrders++;
    } catch (err) {
      errors++;
      log.error({ event: 'cron.referral_recovery.reverse_error', orderId, err });
      Sentry.captureException(err, { tags: { source: 'cron.referral-recovery' } });
    }
  }
  if (stale.length > 0) {
    // Тон сигнала зависит от того, КАК заказ попал в набор.
    //
    // `failed` — автоматический путь, у него есть inline-вызовы отмены. Если
    // строка дошла сюда, значит один из них промахнулся: это аномалия, и её
    // надо разобрать. `refunded`/`cancelled` — ручной путь оператора, inline-
    // вызова там нет и быть не может, поэтому гашение здесь штатное. Кричать
    // «нужен разбор» на каждый возврат значит приучить владельца игнорировать
    // денежный алерт (находка ревью).
    const missedInline = stale.filter((o) => o.status === 'failed');
    log.warn({
      event: 'cron.referral_recovery.stale_accruals',
      staleOrders: stale.length,
      missedInline: missedInline.length,
      reversedOrders,
      reversedRows: reversed,
    });
    const now = Date.now();
    if (missedInline.length > 0 && now - lastStaleDmAt >= OPS_DM_DEDUP_MS) {
      lastStaleDmAt = now;
      // Формулировка намеренно не утверждает баг: тот же набор строк даёт и
      // ПЕРВЫЙ прогон после релиза (исторические начисления, которые никто не
      // гасил, потому что фичи не было), и гонка со свежим провалом заказа —
      // inline-путь гасит в отдельном запросе после коммита транзакции, и скан
      // крона может попасть в это окно (находки ревью). Утверждать «есть баг»
      // там, где его может не быть, — верный способ обесценить денежный алерт.
      await notifyOps(
        `Реферальный ledger: сверщик погасил комиссию по ${missedInline.length} ` +
          `провалившемуся(ихся) заказу(ам) — обычно это делает сам путь перевода ` +
          `в failed. Если это не первый прогон после релиза, стоит проверить, ` +
          `какая ветка перестала гасить начисления.`,
      );
    }
  }

  // Зеркальная сверка: заказ СОСТОЯЛСЯ, а комиссия по нему погашена — то есть
  // партнёру недоплачено. До неё сверка была односторонней и ловила только
  // случай «партнёру переплатили», где теряем мы (находка финального ревью).
  // Путь попадания реальный: `markOrderFailed` гасит начисление и при
  // НЕИЗВЕСТНОМ исходе топапа (`paypace_topup_pending`); если топап прошёл и
  // оператор довёл заказ до `completed`, погашение остаётся навсегда.
  //
  // Только сигнал: автоматически дописать `accrued` нельзя (упрётся в частичный
  // UNIQUE), а компенсировать отмену отмены в append-only ledger'е — верный
  // способ получить двойное начисление, которое уже не вычистить.
  try {
    const underpaid = await findPurchasedOrdersWithReversedAccruals(db, RECOVERY_LIMIT);
    if (underpaid.length > 0) {
      log.error({
        event: 'cron.referral_recovery.reversed_on_purchased_order',
        orders: underpaid.length,
      });
      Sentry.captureMessage('Реферальная комиссия погашена по состоявшемуся заказу', {
        level: 'error',
        tags: { source: 'cron.referral-recovery', alert: 'referral_underpaid' },
        extra: { orders: underpaid.slice(0, 20) },
      });
    }
    const nowUnderpaid = Date.now();
    if (underpaid.length > 0 && nowUnderpaid - lastUnderpaidDmAt >= OPS_DM_DEDUP_MS) {
      lastUnderpaidDmAt = nowUnderpaid;
      await notifyOps(
        `Реферальный ledger: по ${underpaid.length} состоявшемуся(имся) заказу(ам) ` +
          `комиссия партнёра погашена — партнёру недоплачено. Обычно это заказ, ` +
          `который упал при неизвестном исходе топапа, а потом был доведён до ` +
          `завершения вручную. Восстановление ручное, автоматически не досчитываем.`,
      );
    }
  } catch (err) {
    errors++;
    log.error({ event: 'cron.referral_recovery.underpaid_check_error', err });
    Sentry.captureException(err, { tags: { source: 'cron.referral-recovery' } });
  }

  // Отрицательный баланс — отдельная аномалия: отмена пришла на деньги, по
  // которым уже подана заявка на вывод (её сумма вычитается из баланса, и
  // клавбэк вычитается второй раз). Выплаты ручные, поэтому смысл сигнала —
  // успеть сказать владельцу ДО перевода.
  try {
    const negative = await findNegativeReferralBalances(db, RECOVERY_LIMIT);
    if (negative.length > 0) {
      log.error({ event: 'cron.referral_recovery.negative_balance', partners: negative.length });
    }
    const nowNegative = Date.now();
    if (negative.length > 0 && nowNegative - lastNegativeDmAt >= OPS_DM_DEDUP_MS) {
      lastNegativeDmAt = nowNegative;
      await notifyOps(
        `Реферальный баланс ушёл в отрицательные значения у ${negative.length} ` +
          `партнёра(ов): отмена начисления пришла на деньги, по которым уже есть ` +
          `заявка на вывод. Проверить до перевода.`,
      );
    }
  } catch (err) {
    errors++;
    log.error({ event: 'cron.referral_recovery.negative_check_error', err });
    Sentry.captureException(err, { tags: { source: 'cron.referral-recovery' } });
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
