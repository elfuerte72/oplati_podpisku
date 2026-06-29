import { sql } from 'drizzle-orm';

import type { DB } from '../index.ts';

/**
 * Ledger начислений (Этап B). Append-only: только INSERT, никогда UPDATE/DELETE.
 * Идемпотентность commission — UNIQUE(payment_id, beneficiary, level) +
 * ON CONFLICT DO NOTHING. Расчёт ставок — чистый planCommissionAccruals
 * (@oplati/types); здесь только примитивы доступа к БД.
 */

export type PartnerProfile = {
  circle: number;
  lockedRateL1Bps: number;
  teamMultiplier: boolean;
  /** Активный буст в bps (0 если истёк/не задан — считается на стороне SQL). */
  boostBps: number;
  suspended: boolean;
};

/**
 * Профиль партнёра для расчёта ставки. `null` — профиля ещё нет (трактуется как
 * круг 0 / Клиент). Буст применяется только если `boost_until >= CURRENT_DATE`.
 */
export async function getPartnerProfile(db: DB, userId: string): Promise<PartnerProfile | null> {
  const rows = await db.execute<{
    current_circle: number;
    locked_rate_l1_bps: number;
    team_multiplier: boolean;
    boost_bps: number;
    suspended: boolean;
  }>(sql`
    SELECT
      current_circle,
      locked_rate_l1_bps,
      team_multiplier,
      CASE
        WHEN boost_until IS NOT NULL AND boost_until >= CURRENT_DATE
        THEN COALESCE(boost_rate_bps, 0)
        ELSE 0
      END AS boost_bps,
      suspended
    FROM referral_partners
    WHERE user_id = ${userId}
    LIMIT 1
  `);
  const r = rows[0];
  if (!r) return null;
  return {
    circle: r.current_circle,
    lockedRateL1Bps: r.locked_rate_l1_bps,
    teamMultiplier: r.team_multiplier,
    boostBps: r.boost_bps,
    suspended: r.suspended,
  };
}

export type CommissionAccrualInsert = {
  beneficiaryUserId: string;
  level: number;
  rateBps: number;
  amountUsdCents: number;
};

/**
 * Вставляет commission-начисления идемпотентно (ON CONFLICT DO NOTHING по
 * UNIQUE(payment_id, beneficiary, level)). Возвращает число РЕАЛЬНО вставленных
 * строк (0 при полном дубле — повторный webhook/poll). Строк ≤3 (глубина сети),
 * поэтому простой цикл, а не bulk-INSERT.
 */
export async function insertCommissionAccruals(
  db: DB,
  params: {
    sourceUserId: string;
    orderId: string;
    paymentId: string;
    rows: readonly CommissionAccrualInsert[];
  },
): Promise<number> {
  const { sourceUserId, orderId, paymentId, rows } = params;
  let inserted = 0;
  for (const row of rows) {
    const res = await db.execute<{ id: string }>(sql`
      INSERT INTO referral_accruals
        (beneficiary_user_id, source_user_id, order_id, payment_id, level, kind, rate_bps, amount_usd_cents)
      VALUES (
        ${row.beneficiaryUserId}, ${sourceUserId}, ${orderId}, ${paymentId},
        ${row.level}, 'commission', ${row.rateBps}, ${row.amountUsdCents}
      )
      ON CONFLICT (payment_id, beneficiary_user_id, level) DO NOTHING
      RETURNING id
    `);
    if (res[0]?.id) inserted++;
  }
  return inserted;
}

/**
 * Баланс партнёра к выводу (USD-центы): начислено (status=accrued) минус выведено
 * (status processing|paid). `reversed`-начисления и отклонённые/новые заявки не
 * учитываются. Cast `::int` — как в getWebSessionProfile (на нашем масштабе влезает).
 */
export async function getReferralBalanceUsdCents(db: DB, userId: string): Promise<number> {
  const rows = await db.execute<{ balance: number }>(sql`
    SELECT (
      COALESCE((
        SELECT SUM(amount_usd_cents) FROM referral_accruals
        WHERE beneficiary_user_id = ${userId} AND status = 'accrued'
      ), 0)
      - COALESCE((
        SELECT SUM(amount_usd_cents) FROM referral_payouts
        WHERE user_id = ${userId} AND status IN ('processing', 'paid')
      ), 0)
    )::int AS balance
  `);
  return rows[0]?.balance ?? 0;
}

/**
 * Есть ли у заказа хоть одна строка начисления (любого kind) — для recovery-крона
 * (Этап B ч.2): заказ paid+ с реферером, но без начислений = пропуск, досчитать.
 */
export async function orderHasAccruals(db: DB, orderId: string): Promise<boolean> {
  const rows = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM referral_accruals WHERE order_id = ${orderId}
    ) AS exists
  `);
  return rows[0]?.exists ?? false;
}

export type OrderMissingAccrual = { orderId: string; paymentId: string };

/**
 * Recovery-кандидаты: заказы со статусом paid+ у пользователя с реферером, с
 * USD-базой и успешным платежом, но БЕЗ единой строки начисления (пропуск, если
 * БД упала в момент webhook). `DISTINCT ON (o.id)` гарантирует ровно один платёж
 * на заказ (последний succeeded) — иначе один заказ начислился бы дважды на
 * разные payment_id. NOT EXISTS гасит уже начисленные. accrueReferralForPayment
 * перепроверит всё сам и идемпотентен — здесь лишь находим orderId+paymentId.
 */
export async function findOrdersMissingReferralAccruals(
  db: DB,
  limit: number,
): Promise<OrderMissingAccrual[]> {
  const rows = await db.execute<{ order_id: string; payment_id: string }>(sql`
    SELECT order_id, payment_id FROM (
      SELECT DISTINCT ON (o.id)
        o.id AS order_id,
        p.id AS payment_id,
        o.paid_at AS paid_at
      FROM orders o
      JOIN users u ON u.id = o.user_id AND u.referred_by IS NOT NULL
      JOIN payments p ON p.order_id = o.id AND p.status = 'succeeded'
      WHERE o.status IN ('paid', 'in_fulfillment', 'completed')
        AND o.original_amount IS NOT NULL
        AND o.original_amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM referral_accruals ra WHERE ra.order_id = o.id
        )
      ORDER BY o.id, p.created_at DESC
    ) s
    ORDER BY s.paid_at DESC NULLS LAST
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ orderId: r.order_id, paymentId: r.payment_id }));
}
