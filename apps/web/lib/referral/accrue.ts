import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  getDb,
  getOrderById,
  getPartnerProfile,
  getReferralAncestors,
  insertCommissionAccruals,
} from '@oplati/db';
import {
  planCommissionAccruals,
  REFERRAL_RATE_TABLE,
  type AccrualBeneficiary,
} from '@oplati/types';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';

/** Базовая ставка первого статуса — когда профиля партнёра ещё нет. */
const DEFAULT_LOCKED_L1_BPS = REFERRAL_RATE_TABLE[0]?.l1Bps ?? 400;

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
    // Guard от дрейфа валют (находка аудита): original_amount трактуется как
    // USD-центы; если когда-нибудь появятся заказы в другой валюте, начислять
    // по ним как по USD нельзя. NULL считаем USD (текущие пути пишут 'USD').
    const originalCurrency = order.originalCurrency ?? 'USD';
    if (originalCurrency !== 'USD') {
      log.warn({ event: 'referral.accrue.non_usd_base', orderId, currency: originalCurrency });
      return;
    }
    const sourceUserId = order.userId;

    // Программа одноуровневая: начисляем только прямому рефереру
    // (REFERRAL_MAX_LEVEL=1 — дефолт глубины в getReferralAncestors).
    const ancestors = await getReferralAncestors(db, sourceUserId);
    if (ancestors.length === 0) {
      log.info({ event: 'referral.accrue.no_referrer', orderId });
      return;
    }

    // Ставка берётся из ТЕКУЩЕГО профиля партнёра, не из снимка на момент оплаты.
    // С приходом Этапа C (месячный крон мутирует circle/boost) это осознанный
    // компромисс: inline-путь (сразу после оплаты) всегда считает по актуальной
    // ставке — корректно. Расхождение возможно ТОЛЬКО на редком recovery-пути,
    // если начисление промахнулось и досчитывается в следующем месяце после
    // повышения круга/истечения буста (храповик → лёгкая переплата, истёкший
    // буст → лёгкая недоплата). Оба ограничены инвариантом «≤ комиссия» и
    // величиной ≤2% от базы. Снапшот круга на заказ (доп. колонка) сочли
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
        // Ставка — ЗАФИКСИРОВАННАЯ, а не выведенная из текущего статуса
        // (решение владельца 2026-08-11): именно её партнёр видит в кабинете,
        // и «процент не падает» — это данное ему обещание. Профиля ещё нет —
        // базовая ставка первого статуса, ровно как было при `circle = 0`.
        lockedRateL1Bps: profile?.lockedRateL1Bps ?? DEFAULT_LOCKED_L1_BPS,
        boostBps: profile?.boostBps ?? 0,
      });
    }

    const rows = planCommissionAccruals(baseUsdCents, beneficiaries);
    if (rows.length === 0) {
      log.info({ event: 'referral.accrue.zero_rows', orderId });
      return;
    }

    // Инвариант «начисление ≤ маржа»: выплата не должна превышать комиссию
    // заказа. С базовыми ставками (макс. 7%) и комиссией 30% не срабатывает;
    // защита от будущих модификаторов/мисконфига.
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
