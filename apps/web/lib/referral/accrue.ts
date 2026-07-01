import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  getDb,
  getOrderById,
  getPartnerProfile,
  getReferralAncestors,
  insertCommissionAccruals,
} from '@oplati/db';
import { planCommissionAccruals, type AccrualBeneficiary } from '@oplati/types';

import { serverEnv } from '@/lib/env';
import { childLogger } from '@/lib/logger';

const log = childLogger('referral-accrue');

/**
 * Начисление реферальных commission-вознаграждений за оплаченный заказ.
 *
 * Вызывается из `processInvoicePaid` СРАЗУ после `claimPaymentSucceeded` (точка
 * at-most-once: сюда попадает только победитель гонки webhook↔poll). Плюс
 * идемпотентность на уровне БД (UNIQUE payment_id+beneficiary+level), так что
 * повторный вызов дублей не создаёт.
 *
 * Graceful: любой сбой проглатывается (Sentry), чтобы НЕ сорвать обработку
 * платежа — заказ всё равно становится `paid`. Пропущенное начисление досчитает
 * recovery-cron. Гейт `REFERRAL_ENABLED`.
 *
 * База начисления — `original_amount` заказа (USD-центы). Инвариант: суммарное
 * начисление цепочки ≤ комиссия заказа (платим из маржи, не сверх цены клиента).
 */
export async function accrueReferralForPayment(params: {
  orderId: string;
  paymentId: string;
}): Promise<void> {
  if (!serverEnv.REFERRAL_ENABLED) return;
  const { orderId, paymentId } = params;

  try {
    const db = getDb();
    const order = await getOrderById(db, orderId);
    if (!order) {
      log.warn({ event: 'referral.accrue.order_not_found', orderId });
      return;
    }

    const baseUsdCents = order.originalAmount ?? 0;
    if (baseUsdCents <= 0) {
      // Нет USD-базы (например, заказ вне каталога без цены) — начислять не с чего.
      log.info({ event: 'referral.accrue.no_base', orderId });
      return;
    }
    const sourceUserId = order.userId;

    const ancestors = await getReferralAncestors(db, sourceUserId, 3);
    if (ancestors.length === 0) {
      log.info({ event: 'referral.accrue.no_referrer', orderId });
      return;
    }

    // Ставка берётся из ТЕКУЩЕГО профиля партнёра, не из снимка на момент оплаты.
    // С приходом Этапа C (месячный крон мутирует circle/boost/team_multiplier)
    // это осознанный компромисс: inline-путь (сразу после оплаты) всегда считает
    // по актуальной ставке — корректно. Расхождение возможно ТОЛЬКО на редком
    // recovery-пути, если начисление промахнулось и досчитывается в следующем
    // месяце после повышения круга/истечения буста (храповик → лёгкая переплата,
    // истёкший буст → лёгкая недоплата). Оба ограничены инвариантом «≤ комиссия»
    // и величиной ≤2% от базы. Снапшот круга на заказ (доп. колонка) сочли
    // избыточным для масштаба; при росте объёмов — вернуться к снапшоту.
    const beneficiaries: AccrualBeneficiary[] = [];
    for (const a of ancestors) {
      const profile = await getPartnerProfile(db, a.userId);
      if (profile?.suspended) {
        // Антифрод-блок: исключаем из начисления (Этап E).
        log.info({ event: 'referral.accrue.suspended_skip', orderId, level: a.level });
        continue;
      }
      beneficiaries.push({
        userId: a.userId,
        level: a.level,
        circle: profile?.circle ?? 0,
        teamMultiplier: profile?.teamMultiplier ?? false,
        boostBps: profile?.boostBps ?? 0,
      });
    }

    const rows = planCommissionAccruals(baseUsdCents, beneficiaries);
    if (rows.length === 0) {
      log.info({ event: 'referral.accrue.zero_rows', orderId });
      return;
    }

    // Инвариант «начисление ≤ маржа»: суммарная выплата не должна превышать
    // комиссию заказа. С базовыми ставками (макс. цепочка 10%) и комиссией 30%
    // не срабатывает; защита от будущих модификаторов/мисконфига.
    const commissionPercent = order.commissionPercent ?? serverEnv.COMMISSION_PERCENT;
    const commissionUsdCents = Math.floor((baseUsdCents * commissionPercent) / 100);
    const totalAccrual = rows.reduce((sum, r) => sum + r.amountUsdCents, 0);
    if (totalAccrual > commissionUsdCents) {
      log.error({
        event: 'referral.accrue.exceeds_commission',
        orderId,
        totalAccrual,
        commissionUsdCents,
      });
      Sentry.captureMessage('referral accrual exceeds commission', {
        level: 'error',
        tags: { source: 'referral.accrue', alert: 'exceeds_commission' },
        extra: { orderId, totalAccrual, commissionUsdCents },
      });
      return; // не начисляем сверх маржи
    }

    const inserted = await insertCommissionAccruals(db, {
      sourceUserId,
      orderId,
      paymentId,
      rows,
    });
    log.info({
      event: 'referral.accrue.done',
      orderId,
      beneficiaries: beneficiaries.length,
      planned: rows.length,
      inserted,
    });
  } catch (err) {
    // Graceful: сбой начисления НЕ ломает обработку платежа. Recovery-cron досчитает.
    log.error({ event: 'referral.accrue.failed', orderId, err });
    Sentry.captureException(err, { tags: { source: 'referral.accrue' } });
  }
}
