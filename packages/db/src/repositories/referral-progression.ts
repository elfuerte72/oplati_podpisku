import { sql } from 'drizzle-orm';

import type { ProgressionBonus } from '@oplati/types';

import type { DB } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Доступ к БД для месячной прогрессии партнёров (Этап C, крон `referral-rollup`).
 *
 * Чистая бизнес-логика (храповик кругов, бонусы, буст, серия) — в
 * `planMonthlyProgression` (@oplati/types, тестируется без БД). Здесь только
 * примитивы доступа: кандидаты, месячные агрегаты и атомарное применение решения.
 *
 * Идемпотентность месяца — PK(user_id, month) в `referral_monthly_stats`:
 * `applyMonthlyProgression` вставляет строку статистики `ON CONFLICT DO NOTHING`
 * и применяет мутации (профиль + бонусы) ТОЛЬКО если строка реально вставилась.
 * Повторный прогон того же месяца — no-op (at-most-once на партнёра за месяц).
 *
 * Оконные границы месяца выводятся в SQL из `${monthKey}` (`'YYYY-MM-01'`):
 * `paid_at >= monthKey::date AND paid_at < monthKey::date + interval '1 month'`.
 * Сессия Supabase — UTC (как и остальной код с `date_trunc('month', now())`).
 * «Активный реферал» = заказ в статусах paid/in_fulfillment/completed (D-REF-5).
 */

const PURCHASED = sql`('paid','in_fulfillment','completed')`;

/**
 * Кандидаты на rollup — все пользователи, которые кого-то пригласили (есть хотя бы
 * один реферал с `referred_by = them`). Только у них может быть оборот сети; у
 * остальных статистику считать не с чего.
 */
export async function listReferralRollupCandidates(db: DB): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT referred_by AS id
    FROM users
    WHERE referred_by IS NOT NULL
  `);
  return rows.map((r) => r.id);
}

export type MonthlyRollupInput = {
  networkTurnoverUsdCents: number;
  newActiveReferrals: number;
  activeL2Count: number;
};

/**
 * Месячные агрегаты партнёра за месяц `monthKey`:
 *  - оборот сети (L1+L2+L3) — сумма `original_amount` купленных заказов downline
 *    с `paid_at` внутри месяца (D-REF-2);
 *  - активные L2 — рефералы 2-го уровня с ≥1 покупкой (для командного множителя);
 *  - новые активные L1 — прямые рефералы, привязанные в этом месяце и активные
 *    (для спринта «10 новых активных»).
 *
 * Обход дерева ограничен глубиной 3 (`n.level < 3`) — всегда завершается.
 */
export async function getMonthlyRollupInput(
  db: DB,
  userId: string,
  monthKey: string,
): Promise<MonthlyRollupInput> {
  const netRows = await db.execute<{ turnover: string | number; active_l2: string | number }>(sql`
    WITH RECURSIVE net AS (
      SELECT id, 1 AS level FROM users WHERE referred_by = ${userId}
      UNION ALL
      SELECT u.id, n.level + 1
      FROM users u
      JOIN net n ON u.referred_by = n.id
      WHERE n.level < 3
    )
    SELECT
      COALESCE(SUM(mt.turnover), 0)::bigint AS turnover,
      COUNT(*) FILTER (WHERE n.level = 2 AND act.is_active) AS active_l2
    FROM net n
    LEFT JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1 FROM orders o
        WHERE o.user_id = n.id AND o.status IN ${PURCHASED}
      ) AS is_active
    ) act ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(o.original_amount), 0) AS turnover
      FROM orders o
      WHERE o.user_id = n.id
        AND o.status IN ${PURCHASED}
        AND o.original_amount IS NOT NULL
        AND o.paid_at >= ${monthKey}::date
        AND o.paid_at < (${monthKey}::date + interval '1 month')
    ) mt ON true
  `);

  const newRows = await db.execute<{ new_active: string | number }>(sql`
    SELECT COUNT(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status IN ${PURCHASED}
      )
    ) AS new_active
    FROM users u
    WHERE u.referred_by = ${userId}
      AND u.referred_by_set_at >= ${monthKey}::date
      AND u.referred_by_set_at < (${monthKey}::date + interval '1 month')
  `);

  const net = netRows[0];
  return {
    networkTurnoverUsdCents: Number(net?.turnover ?? 0),
    activeL2Count: Number(net?.active_l2 ?? 0),
    newActiveReferrals: Number(newRows[0]?.new_active ?? 0),
  };
}

/**
 * Длина серии выполненных планов на конец ПРЕДЫДУЩЕГО месяца (0 если истории нет).
 * Читает `consecutive_met_months` строки статистики за `monthKey − 1 месяц`.
 */
export async function getPriorConsecutiveMetMonths(
  db: DB,
  userId: string,
  monthKey: string,
): Promise<number> {
  const rows = await db.execute<{ consecutive_met_months: number }>(sql`
    SELECT consecutive_met_months
    FROM referral_monthly_stats
    WHERE user_id = ${userId}
      AND month = (${monthKey}::date - interval '1 month')::date
    LIMIT 1
  `);
  return Number(rows[0]?.consecutive_met_months ?? 0);
}

export type ApplyMonthlyProgressionParams = {
  userId: string;
  /** Первое число обрабатываемого месяца, `'YYYY-MM-01'`. */
  monthKey: string;
  stats: {
    networkTurnoverUsdCents: number;
    newActiveReferrals: number;
    activeL2Count: number;
    planMet: boolean;
    consecutiveMetMonths: number;
  };
  profile: {
    newCircle: number;
    newLockedRateL1Bps: number;
    teamMultiplier: boolean;
  };
  /** Буст на следующий месяц; `null` — не выдан (сбрасывает прошлый буст). */
  boost: { until: string; rateBps: number } | null;
  bonuses: readonly ProgressionBonus[];
};

export type ApplyMonthlyProgressionResult =
  | { applied: true; bonusesInserted: number }
  | { applied: false };

/**
 * Атомарно применяет решение прогрессии за месяц.
 *
 *  1. INSERT строки `referral_monthly_stats` `ON CONFLICT (user_id, month) DO
 *     NOTHING`. Если строки нет (месяц уже обработан) — выходим без мутаций
 *     (идемпотентность на партнёра за месяц).
 *  2. Upsert `referral_partners`: круг и ставка L1 — через `GREATEST` (храповик:
 *     не понижаем, даже если профиль изменился между чтением и транзакцией);
 *     `team_multiplier`/буст — перезапись (пересчитываются каждый месяц, буст
 *     живёт один месяц). Всё в ОДНОЙ транзакции со статистикой.
 *  3. Бонусы (circle/sprint/serial) — строки в append-only `referral_accruals`
 *     (level 0, rate 0, payment/order/source = NULL). Дедуп обеспечивает шаг 1.
 */
export async function applyMonthlyProgression(
  db: DB,
  params: ApplyMonthlyProgressionParams,
  log: RepoLogger = noopLogger,
): Promise<ApplyMonthlyProgressionResult> {
  const { userId, monthKey, stats, profile, boost, bonuses } = params;
  return db.transaction(async (tx) => {
    const inserted = await tx.execute<{ user_id: string }>(sql`
      INSERT INTO referral_monthly_stats
        (user_id, month, network_turnover_usd_cents, new_active_referrals, active_l2, plan_met, consecutive_met_months)
      VALUES (
        ${userId}, ${monthKey}::date,
        ${stats.networkTurnoverUsdCents}, ${stats.newActiveReferrals}, ${stats.activeL2Count},
        ${stats.planMet}, ${stats.consecutiveMetMonths}
      )
      ON CONFLICT (user_id, month) DO NOTHING
      RETURNING user_id
    `);
    if (!inserted[0]) {
      return { applied: false };
    }

    const boostUntil = boost ? boost.until : null;
    const boostRateBps = boost ? boost.rateBps : null;
    await tx.execute(sql`
      INSERT INTO referral_partners
        (user_id, current_circle, locked_rate_l1_bps, team_multiplier, boost_until, boost_rate_bps, updated_at)
      VALUES (
        ${userId}, ${profile.newCircle}, ${profile.newLockedRateL1Bps}, ${profile.teamMultiplier},
        ${boostUntil}::date, ${boostRateBps}, now()
      )
      ON CONFLICT (user_id) DO UPDATE SET
        current_circle = GREATEST(referral_partners.current_circle, EXCLUDED.current_circle),
        locked_rate_l1_bps = GREATEST(referral_partners.locked_rate_l1_bps, EXCLUDED.locked_rate_l1_bps),
        team_multiplier = EXCLUDED.team_multiplier,
        boost_until = EXCLUDED.boost_until,
        boost_rate_bps = EXCLUDED.boost_rate_bps,
        updated_at = now()
    `);

    let bonusesInserted = 0;
    for (const b of bonuses) {
      if (b.amountUsdCents <= 0) continue;
      await tx.execute(sql`
        INSERT INTO referral_accruals
          (beneficiary_user_id, source_user_id, order_id, payment_id, level, kind, rate_bps, amount_usd_cents)
        VALUES (${userId}, NULL, NULL, NULL, 0, ${b.kind}, 0, ${b.amountUsdCents})
      `);
      bonusesInserted++;
    }

    log.info({ event: 'db.referral.rollup_applied', userId, monthKey, bonusesInserted });
    return { applied: true, bonusesInserted };
  });
}
