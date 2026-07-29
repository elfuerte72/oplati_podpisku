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
const ROLLUP_CANDIDATES_LIMIT = 5000;

export async function listReferralRollupCandidates(db: DB): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT referred_by AS id
    FROM users
    WHERE referred_by IS NOT NULL
    -- Кап с детерминированным порядком: прогрессия зовётся раз в месяц, и на
    -- каждого партнёра приходится несколько запросов. Без предела рост
    -- партнёрской сети однажды упрёт джоб в таймаут, а идемпотентность
    -- (PK по user_id и month) означает, что оборванный прогон переигрывался бы
    -- с самого начала — то есть хвост списка не обработался бы НИКОГДА.
    -- С капом и ORDER BY недобор виден в логе ровно как счётчик, равный капу.
    ORDER BY id
    LIMIT ${ROLLUP_CANDIDATES_LIMIT}
  `);
  return rows.map((r) => r.id);
}

export type MonthlyRollupInput = {
  networkTurnoverUsdCents: number;
  newActiveReferrals: number;
};

/**
 * Месячные агрегаты партнёра за месяц `monthKey` (программа одноуровневая):
 *  - оборот прямых рефералов — сумма `original_amount` их купленных заказов
 *    с `paid_at` внутри месяца (D-REF-2);
 *  - новые активные — прямые рефералы, привязанные в этом месяце и активные
 *    (для спринта «10 новых активных»).
 */
export async function getMonthlyRollupInput(
  db: DB,
  userId: string,
  monthKey: string,
): Promise<MonthlyRollupInput> {
  const netRows = await db.execute<{ turnover: string | number }>(sql`
    SELECT COALESCE(SUM(o.original_amount), 0)::bigint AS turnover
    FROM orders o
    JOIN users u ON u.id = o.user_id
    WHERE u.referred_by = ${userId}
      AND o.status IN ${PURCHASED}
      AND o.original_amount IS NOT NULL
      -- Оборот считается в USD-центах, и суммировать разные валюты как одно
      -- число нельзя: не-USD заказ завысил бы оборот и мог бы вытолкнуть
      -- партнёра на статус со ставкой выше заслуженной. Тот же guard давно
      -- стоит в accrue-пути — здесь его не было (L-1).
      AND o.original_currency = 'USD'
      AND o.paid_at >= ${monthKey}::date
      AND o.paid_at < (${monthKey}::date + interval '1 month')
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

  return {
    networkTurnoverUsdCents: Number(netRows[0]?.turnover ?? 0),
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
    planMet: boolean;
    consecutiveMetMonths: number;
  };
  profile: {
    newCircle: number;
    newLockedRateL1Bps: number;
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
 *  2. Upsert `referral_partners`: круг и ставка — через `GREATEST` (храповик:
 *     не понижаем, даже если профиль изменился между чтением и транзакцией);
 *     буст — перезапись (пересчитывается каждый месяц, живёт один месяц);
 *     легаси-колонки `active_l2`/`team_multiplier` обнуляются (программа
 *     одноуровневая, командного множителя больше нет). Всё в ОДНОЙ транзакции
 *     со статистикой.
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
        ${stats.networkTurnoverUsdCents}, ${stats.newActiveReferrals}, 0,
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
        ${userId}, ${profile.newCircle}, ${profile.newLockedRateL1Bps}, false,
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
