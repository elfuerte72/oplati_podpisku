import { sql } from 'drizzle-orm';

import {
  isTerminalPayoutStatus,
  type PayoutMethod,
  type PayoutStatus,
  type PayoutDestinationStored,
} from '@oplati/types';

import type { DB } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Read-агрегаты партнёрского кабинета (Этап D). Только чтение — считают сводку
 * сети/дохода для снапшота `buildReferralSnapshot` (apps/web/lib/cabinet) + одна
 * запись (заявка на вывод). Расчёт ставок/кругов — чистый код в @oplati/types;
 * здесь только примитивы доступа к БД (raw SQL, как остальные репозитории).
 *
 * Деньги — USD-центы integer. Суммы кастуются `::bigint` + `Number` (без
 * переполнения на больших оборотах, в духе инварианта «деньги — integer»).
 *
 * Заметка по сети: обход дерева `referred_by` ограничен глубиной 3 (`level < 3`
 * в рекурсивном CTE), так что запрос всегда останавливается — даже если бы в
 * данных оказался цикл (immutable-referrer + CHECK самореферала их исключают).
 * «Состоявшаяся покупка» реферала = заказ в статусах paid/in_fulfillment/completed.
 */

const PURCHASED = sql`('paid','in_fulfillment','completed')`;
const MONTH_START = sql`date_trunc('month', now())`;

export type ReferralNetworkLevel = {
  level: number;
  total: number;
  active: number;
  turnoverThisMonthUsdCents: number;
};

/**
 * Сводка сети по 3 уровням: всего рефералов, активных (≥1 покупка) и оборот их
 * заказов за текущий месяц (USD-центы). Один рекурсивный обход дерева вниз.
 * Возвращает по строке на уровень, где есть хоть один реферал (уровни без сети
 * опускаются — заполняет нулями вызывающий код).
 */
export async function getReferralNetwork(db: DB, userId: string): Promise<ReferralNetworkLevel[]> {
  const rows = await db.execute<{
    level: number;
    total: string | number;
    active: string | number;
    turnover_month: string | number;
  }>(sql`
    WITH RECURSIVE net AS (
      SELECT id, 1 AS level FROM users WHERE referred_by = ${userId}
      UNION ALL
      SELECT u.id, n.level + 1
      FROM users u
      JOIN net n ON u.referred_by = n.id
      WHERE n.level < 3
    )
    SELECT
      n.level,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE act.is_active) AS active,
      COALESCE(SUM(mt.turnover), 0)::bigint AS turnover_month
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
        AND o.paid_at >= ${MONTH_START}
    ) mt ON true
    GROUP BY n.level
    ORDER BY n.level
  `);
  return rows.map((r) => ({
    level: Number(r.level),
    total: Number(r.total),
    active: Number(r.active),
    turnoverThisMonthUsdCents: Number(r.turnover_month),
  }));
}

export type ReferralLevelIncome = {
  level: number;
  allTimeUsdCents: number;
  thisMonthUsdCents: number;
};

/**
 * Доход партнёра по уровням сети из commission-начислений: за всё время и за
 * текущий месяц (accrued − reversed). Только `kind='commission'`, уровни 1..3.
 */
export async function getReferralIncomeByLevel(
  db: DB,
  userId: string,
): Promise<ReferralLevelIncome[]> {
  const rows = await db.execute<{
    level: number;
    all_time: string | number;
    this_month: string | number;
  }>(sql`
    SELECT
      level,
      (
        COALESCE(SUM(amount_usd_cents) FILTER (WHERE status = 'accrued'), 0)
        - COALESCE(SUM(amount_usd_cents) FILTER (WHERE status = 'reversed'), 0)
      )::bigint AS all_time,
      (
        COALESCE(SUM(amount_usd_cents) FILTER (WHERE status = 'accrued' AND created_at >= ${MONTH_START}), 0)
        - COALESCE(SUM(amount_usd_cents) FILTER (WHERE status = 'reversed' AND created_at >= ${MONTH_START}), 0)
      )::bigint AS this_month
    FROM referral_accruals
    WHERE beneficiary_user_id = ${userId}
      AND kind = 'commission'
      AND level BETWEEN 1 AND 3
    GROUP BY level
    ORDER BY level
  `);
  return rows.map((r) => ({
    level: Number(r.level),
    allTimeUsdCents: Number(r.all_time),
    thisMonthUsdCents: Number(r.this_month),
  }));
}

export type ReferralEarnings = { totalUsdCents: number; thisMonthUsdCents: number };

/**
 * Брутто-заработок партнёра (все kind: commission + бонусы), accrued − reversed,
 * за всё время и за текущий месяц. Это НЕ баланс к выводу (тот учитывает выплаты —
 * см. `getReferralBalanceUsdCents`).
 */
export async function getReferralEarnings(db: DB, userId: string): Promise<ReferralEarnings> {
  const rows = await db.execute<{ total: string | number; this_month: string | number }>(sql`
    SELECT
      (
        COALESCE(SUM(amount_usd_cents) FILTER (WHERE status = 'accrued'), 0)
        - COALESCE(SUM(amount_usd_cents) FILTER (WHERE status = 'reversed'), 0)
      )::bigint AS total,
      (
        COALESCE(SUM(amount_usd_cents) FILTER (WHERE status = 'accrued' AND created_at >= ${MONTH_START}), 0)
        - COALESCE(SUM(amount_usd_cents) FILTER (WHERE status = 'reversed' AND created_at >= ${MONTH_START}), 0)
      )::bigint AS this_month
    FROM referral_accruals
    WHERE beneficiary_user_id = ${userId}
  `);
  const r = rows[0];
  return {
    totalUsdCents: Number(r?.total ?? 0),
    thisMonthUsdCents: Number(r?.this_month ?? 0),
  };
}

export type ReferralMonthlyIncomePoint = { month: string; usdCents: number };

/**
 * Доход помесячно (accrued − reversed) за последние `months` месяцев, ключ —
 * `YYYY-MM`. Возвращает только месяцы, где были начисления; пропуски заполняет
 * нулями вызывающий код (чтобы график был сплошным).
 */
export async function getReferralMonthlyIncome(
  db: DB,
  userId: string,
  months: number,
): Promise<ReferralMonthlyIncomePoint[]> {
  const span = Math.max(1, Math.min(36, Math.floor(months)));
  const rows = await db.execute<{ month: string; usd_cents: string | number }>(sql`
    SELECT
      to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
      (
        COALESCE(SUM(amount_usd_cents) FILTER (WHERE status = 'accrued'), 0)
        - COALESCE(SUM(amount_usd_cents) FILTER (WHERE status = 'reversed'), 0)
      )::bigint AS usd_cents
    FROM referral_accruals
    WHERE beneficiary_user_id = ${userId}
      AND created_at >= date_trunc('month', now()) - (${span - 1} || ' months')::interval
    GROUP BY 1
    ORDER BY 1
  `);
  return rows.map((r) => ({ month: r.month, usdCents: Number(r.usd_cents) }));
}

export type ReferralNewReferrals = { total: number; active: number };

/**
 * Новые прямые рефералы (L1) за текущий месяц (по `referred_by_set_at`) и сколько
 * из них активны (≥1 покупка) — для спринт-цели «10 новых активных».
 */
export async function getNewReferralsThisMonth(
  db: DB,
  userId: string,
): Promise<ReferralNewReferrals> {
  const rows = await db.execute<{ total: string | number; active: string | number }>(sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status IN ${PURCHASED}
        )
      ) AS active
    FROM users u
    WHERE u.referred_by = ${userId}
      AND u.referred_by_set_at >= ${MONTH_START}
  `);
  const r = rows[0];
  return { total: Number(r?.total ?? 0), active: Number(r?.active ?? 0) };
}

export type ReferralLedgerRow = {
  kind: string;
  level: number;
  amountUsdCents: number;
  status: string;
  createdAt: Date;
  sourceName: string | null;
  serviceName: string | null;
  customDescription: string | null;
};

/**
 * Лента начислений (все kind) с именем плательщика и сервисом заказа — для
 * вкладки «История». Сортировка по дате убыв., с лимитом.
 */
export async function getReferralLedger(
  db: DB,
  userId: string,
  limit: number,
): Promise<ReferralLedgerRow[]> {
  const cap = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = await db.execute<{
    kind: string;
    level: number;
    amount_usd_cents: number;
    status: string;
    created_at: string;
    source_name: string | null;
    service_name: string | null;
    custom_description: string | null;
  }>(sql`
    SELECT
      ra.kind,
      ra.level,
      ra.amount_usd_cents,
      ra.status,
      ra.created_at,
      su.display_name AS source_name,
      s.name AS service_name,
      o.custom_service_description AS custom_description
    FROM referral_accruals ra
    LEFT JOIN users su ON su.id = ra.source_user_id
    LEFT JOIN orders o ON o.id = ra.order_id
    LEFT JOIN services s ON s.id = o.service_id
    WHERE ra.beneficiary_user_id = ${userId}
    ORDER BY ra.created_at DESC
    LIMIT ${cap}
  `);
  return rows.map((r) => ({
    kind: r.kind,
    level: Number(r.level),
    amountUsdCents: Number(r.amount_usd_cents),
    status: r.status,
    createdAt: new Date(r.created_at),
    sourceName: r.source_name,
    serviceName: r.service_name,
    customDescription: r.custom_description,
  }));
}

export type ReferralPayoutRow = {
  id: string;
  amountUsdCents: number;
  status: string;
  requestedAt: Date;
  settledAt: Date | null;
};

/** Заявки на вывод партнёра (для вкладки «Выводы»). */
export async function getReferralPayouts(
  db: DB,
  userId: string,
  limit: number,
): Promise<ReferralPayoutRow[]> {
  const cap = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = await db.execute<{
    id: string;
    amount_usd_cents: number;
    status: string;
    requested_at: string;
    settled_at: string | null;
  }>(sql`
    SELECT id, amount_usd_cents, status, requested_at, settled_at
    FROM referral_payouts
    WHERE user_id = ${userId}
    ORDER BY requested_at DESC
    LIMIT ${cap}
  `);
  return rows.map((r) => ({
    id: r.id,
    amountUsdCents: Number(r.amount_usd_cents),
    status: r.status,
    requestedAt: new Date(r.requested_at),
    settledAt: r.settled_at ? new Date(r.settled_at) : null,
  }));
}

export type CreateReferralPayoutResult =
  | { ok: true; payoutId: string }
  | { ok: false; reason: 'insufficient_balance'; balanceUsdCents: number };

/** Реквизиты и удержанная комиссия вывода (Этап E). Все поля опциональны:
 *  заявку можно создать без destination (способ выплат уточняется — D-REF-6). */
export type CreateReferralPayoutOptions = {
  method?: PayoutMethod | null;
  feeUsdCents?: number | null;
  /** Уже замаскированные реквизиты (`toStoredPayoutDestination`) — БЕЗ полного PAN. */
  destination?: PayoutDestinationStored | null;
};

/**
 * Атомарно создаёт заявку на вывод (status='requested'). `method`/`feeUsdCents`/
 * `destination` опциональны (Этап E): при отсутствии реквизитов пишутся NULL —
 * исполнение ждёт способ выплат (D-REF-6). `destination` уже замаскирован
 * вызывающим (полного PAN здесь быть не может — инвариант PCI).
 *
 * Антигонка (находка greptile P1, TOCTOU): баланс-чек и INSERT — в ОДНОЙ
 * транзакции под per-user advisory-локом `pg_advisory_xact_lock(hashtext(userId))`.
 * Раньше баланс читался отдельным запросом ПЕРЕД вставкой — две параллельные
 * заявки могли обе пройти проверку до коммита друг друга и обе вставиться
 * (перевывод/порча ledger'а). Теперь вторая заявка ждёт коммита первой, видит её
 * `requested`-строку в балансе и корректно отклоняется. Баланс считается тем же
 * выражением, что `getReferralBalanceUsdCents` (канон), но внутри транзакции.
 * `amount_usd_cents` — брутто (вычитается из баланса); net = amount − fee уходит
 * партнёру. CHECK `amount > 0` в схеме — последний рубеж.
 */
export async function createReferralPayout(
  db: DB,
  params: { userId: string; amountUsdCents: number } & CreateReferralPayoutOptions,
  log: RepoLogger = noopLogger,
): Promise<CreateReferralPayoutResult> {
  const { userId, amountUsdCents, method, feeUsdCents, destination } = params;
  const destinationJson = destination ? JSON.stringify(destination) : null;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`);

    const balRows = await tx.execute<{ balance: string | number }>(sql`
      SELECT (
        COALESCE((
          SELECT SUM(amount_usd_cents) FROM referral_accruals
          WHERE beneficiary_user_id = ${userId} AND status = 'accrued'
        ), 0)
        - COALESCE((
          SELECT SUM(amount_usd_cents) FROM referral_accruals
          WHERE beneficiary_user_id = ${userId} AND status = 'reversed'
        ), 0)
        - COALESCE((
          SELECT SUM(amount_usd_cents) FROM referral_payouts
          WHERE user_id = ${userId} AND status IN ('requested', 'processing', 'paid')
        ), 0)
      )::bigint AS balance
    `);
    const balanceUsdCents = Number(balRows[0]?.balance ?? 0);
    if (amountUsdCents > balanceUsdCents) {
      return { ok: false, reason: 'insufficient_balance', balanceUsdCents };
    }

    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO referral_payouts
        (user_id, amount_usd_cents, status, method, fee_usd_cents, destination)
      VALUES (
        ${userId}, ${amountUsdCents}, 'requested',
        ${method ?? null}, ${feeUsdCents ?? null}, ${destinationJson}::jsonb
      )
      RETURNING id
    `);
    const id = rows[0]?.id;
    if (!id) {
      throw new Error('createReferralPayout: пустой RETURNING — INSERT не вернул id');
    }
    log.info({ event: 'db.referral.payout_requested', userId, amountUsdCents, method: method ?? null });
    return { ok: true, payoutId: id };
  });
}

export type TransitionReferralPayoutResult = { applied: boolean; status: PayoutStatus };

/**
 * Переводит заявку по статусной машине (`requested→processing→paid|rejected`)
 * условным UPDATE `WHERE id AND status=from` — at-most-once, идемпотентно к
 * повторам/гонкам (проигравший видит `applied=false`, не дублирует эффект).
 * Терминальный статус (`paid`/`rejected`) проставляет `settled_at`. Валидность
 * самого перехода проверяет вызывающий (`canTransitionPayout` в @oplati/types) —
 * здесь только атомарная фиксация. Реальное исполнение выплаты — Этап E.
 */
export async function transitionReferralPayout(
  db: DB,
  params: { payoutId: string; from: PayoutStatus; to: PayoutStatus },
  log: RepoLogger = noopLogger,
): Promise<TransitionReferralPayoutResult> {
  const { payoutId, from, to } = params;
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE referral_payouts
    SET status = ${to},
        settled_at = ${isTerminalPayoutStatus(to) ? sql`now()` : sql`settled_at`}
    WHERE id = ${payoutId} AND status = ${from}
    RETURNING id
  `);
  const applied = rows.length > 0;
  if (applied) {
    log.info({ event: 'db.referral.payout_transitioned', payoutId, from, to });
  }
  return { applied, status: applied ? to : from };
}
