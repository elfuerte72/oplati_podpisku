import { sql } from 'drizzle-orm';

import {
  ANALYTICS_EVENTS,
  ANALYTICS_FUNNEL,
  ANALYTICS_MILESTONES,
} from '@oplati/types';

import type { DB } from '../index.ts';
import { PURCHASED_STATUSES_SQL } from './order-status-sql.ts';

/**
 * Выборки раздела «Аналитика» админ-панели (спека `.scratch/admin-panel-v2/`,
 * ветка A): деньги, воронка, продукт за период.
 *
 * Живут здесь, а не в панели, по правилу «своих SQL в `apps/web` нет» и потому,
 * что потолки обязаны стоять рядом с запросом: панель делит процесс с вебхуками
 * Freekassa и Telegram, и один экран не должен тянуть таблицу целиком в тот же
 * event loop, что принимает деньги. Ряды по дням ограничены длиной окна по
 * построению (панель даёт не больше 90 дней), топы — `LIMIT`.
 *
 * Правила, общие для всех выборок:
 *   - деньги — integer в копейках до самого рендера (инвариант 3), в рубли их
 *     переводит только форматтер панели;
 *   - границы окна — ISO-строки, НЕ `Date`: `Date` в raw-`sql`-фрагменте роняет
 *     боевой postgres-js, а PGlite молчит (инцидент 2026-08-15);
 *   - окно полуоткрытое `[since, until)` по UTC; дни без данных заполняются
 *     нулями на стороне TS, чтобы ряд для графика всегда был полным;
 *   - воронка и клики читаются из вьюхи `analytics_timeline` (миграция 0029) —
 *     той же, что питает Metabase: второго определения «субъекта» в проекте нет.
 */

/** Полуоткрытое окно `[since, until)`, обе границы — ISO-строки в UTC. */
export type AnalyticsRange = { since: string; until: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Календарные UTC-дни окна (`YYYY-MM-DD`), правая граница исключена. Именно по
 * этому списку заполняются нули: SQL возвращает только дни с данными.
 */
export function dayKeysInRange(range: AnalyticsRange): string[] {
  const since = new Date(range.since);
  const until = new Date(range.until);
  const start = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate());
  const keys: string[] = [];
  // Окно короче суток всё равно даёт день начала: `until` внутри того же дня
  // означает «часть дня», а не «ни одного дня».
  for (let t = start; t < until.getTime(); t += DAY_MS) {
    keys.push(new Date(t).toISOString().slice(0, 10));
  }
  return keys;
}

/** Ключ дня по timestamptz — один и тот же на все выборки. */
function dayKeySql(column: ReturnType<typeof sql.raw>) {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
}

function withinRange(column: ReturnType<typeof sql.raw>, range: AnalyticsRange) {
  return sql`${column} >= ${range.since}::timestamptz AND ${column} < ${range.until}::timestamptz`;
}

/** Числа из `db.execute` приходят строками (bigint/numeric) — приводим один раз. */
function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// ─── Деньги ───────────────────────────────────────────────────────────────

export type RevenuePoint = {
  /** `YYYY-MM-DD` по UTC. */
  day: string;
  /** Сумма успешных платежей за день, копейки. */
  amountKopecks: number;
  /** Заказов, покупка по которым состоялась (`PURCHASED_ORDER_STATUSES`). */
  paidOrders: number;
};

/**
 * Выручка и оплаченные заказы по дням.
 *
 * Два источника намеренно (тикет 02): деньги — из `payments` со статусом
 * `succeeded` по времени успеха (`completed_at` ставит `claimPaymentSucceeded`),
 * заказы — из `orders` в покупных статусах по `paid_at`. Они расходятся ровно
 * там, где это важно видеть: оплаченный, но провалившийся на выпуске карты
 * заказ — деньги получены, покупка не состоялась (до возврата платёж остаётся
 * `succeeded`, а заказ уходит в `failed`).
 */
export async function revenueByDay(db: DB, range: AnalyticsRange): Promise<RevenuePoint[]> {
  const rows = await db.execute<{ day: string; amount: string | number | null; orders: string | number | null }>(sql`
    WITH money AS (
      SELECT ${dayKeySql(sql.raw('completed_at'))} AS day, sum(amount_rub) AS amount
      FROM payments
      WHERE status = 'succeeded' AND ${withinRange(sql.raw('completed_at'), range)}
      GROUP BY 1
    ),
    purchases AS (
      SELECT ${dayKeySql(sql.raw('paid_at'))} AS day, count(*) AS orders
      FROM orders
      WHERE status IN ${PURCHASED_STATUSES_SQL} AND ${withinRange(sql.raw('paid_at'), range)}
      GROUP BY 1
    )
    SELECT COALESCE(m.day, p.day) AS day, m.amount, p.orders
    FROM money m
    FULL OUTER JOIN purchases p ON p.day = m.day
  `);

  const byDay = new Map(rows.map((r) => [r.day, r]));
  return dayKeysInRange(range).map((day) => {
    const row = byDay.get(day);
    return {
      day,
      amountKopecks: toInt(row?.amount),
      paidOrders: toInt(row?.orders),
    };
  });
}

export type RevenueSummary = {
  /** Деньги, реально полученные за период (успешные платежи), копейки. */
  amountKopecks: number;
  /** Заказов, покупка по которым состоялась. */
  paidOrders: number;
  /**
   * Средний чек СОСТОЯВШЕЙСЯ покупки: сумма покупных заказов / их число,
   * копейки; `0` при нуле заказов. Считается из одного множества — делить
   * выручку платежей на число покупок значило бы завышать чек на каждом
   * оплаченном, но провалившемся заказе.
   */
  averageKopecks: number;
};

/** Итог за период — те же два источника, что у ряда по дням. */
export async function revenueSummary(db: DB, range: AnalyticsRange): Promise<RevenueSummary> {
  const rows = await db.execute<{
    amount: string | number | null;
    orders: string | number | null;
    purchased: string | number | null;
  }>(sql`
    SELECT
      (SELECT COALESCE(sum(amount_rub), 0) FROM payments
        WHERE status = 'succeeded' AND ${withinRange(sql.raw('completed_at'), range)}) AS amount,
      (SELECT count(*) FROM orders
        WHERE status IN ${PURCHASED_STATUSES_SQL} AND ${withinRange(sql.raw('paid_at'), range)}) AS orders,
      (SELECT COALESCE(sum(amount_rub), 0) FROM orders
        WHERE status IN ${PURCHASED_STATUSES_SQL} AND ${withinRange(sql.raw('paid_at'), range)}) AS purchased
  `);
  const amountKopecks = toInt(rows[0]?.amount);
  const paidOrders = toInt(rows[0]?.orders);
  const purchasedKopecks = toInt(rows[0]?.purchased);
  return {
    amountKopecks,
    paidOrders,
    averageKopecks: paidOrders > 0 ? Math.round(purchasedKopecks / paidOrders) : 0,
  };
}

// ─── Воронка ──────────────────────────────────────────────────────────────

export type FunnelStepRow = {
  step: number;
  name: string;
  /** Человеческая подпись шага — из словаря событий `@oplati/types`. */
  title: string;
  /** Субъектов (`subject_key` вьюхи), дошедших до шага за период. */
  subjects: number;
};

const FUNNEL_TITLES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(ANALYTICS_EVENTS).map(([name, spec]) => [name, spec.title])),
  ...Object.fromEntries(
    Object.entries(ANALYTICS_MILESTONES).map(([name, spec]) => [name, spec.title]),
  ),
};

/**
 * Семь шагов `ANALYTICS_FUNNEL` за период — логика вьюхи `analytics_funnel`
 * (0029), но с фильтром по `occurred_at`: сама вьюха периода не знает.
 *
 * Список шагов берётся из кода, а не из таблицы `analytics_event_types`: та
 * наполняется кроном `retention` из этого же списка и на свежей базе пуста —
 * строки с нулями обязаны быть всегда, иначе пустой период выглядел бы как
 * сломанный экран, а не как тишина.
 */
export async function funnelByPeriod(db: DB, range: AnalyticsRange): Promise<FunnelStepRow[]> {
  const names = ANALYTICS_FUNNEL.map((s) => s.name);
  const rows = await db.execute<{ name: string; subjects: string | number }>(sql`
    SELECT t.name, count(DISTINCT t.subject_key) AS subjects
    FROM analytics_timeline t
    WHERE t.name IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
      AND t.subject_key IS NOT NULL
      AND ${withinRange(sql.raw('t.occurred_at'), range)}
    GROUP BY t.name
  `);
  const byName = new Map(rows.map((r) => [r.name, toInt(r.subjects)]));
  return ANALYTICS_FUNNEL.map((s) => ({
    step: s.step,
    name: s.name,
    title: FUNNEL_TITLES[s.name] ?? s.name,
    subjects: byName.get(s.name) ?? 0,
  }));
}

export type FunnelStepWithConversion = FunnelStepRow & {
  /** Доля от предыдущего шага (0..1+); `null` — считать нечем (первый шаг или ноль до него). */
  conversion: number | null;
};

/** Конверсия шага к предыдущему. Нулевой предыдущий шаг — `null`, не деление на ноль. */
export function stepConversions(rows: readonly FunnelStepRow[]): FunnelStepWithConversion[] {
  return rows.map((row, i) => {
    const prev = rows[i - 1];
    const conversion = prev && prev.subjects > 0 ? row.subjects / prev.subjects : null;
    return { ...row, conversion };
  });
}

// ─── Продукт ──────────────────────────────────────────────────────────────

export type TopServiceRow = {
  /** `null` — заказы вне каталога (свободное описание), одной строкой. */
  serviceSlug: string | null;
  title: string | null;
  orders: number;
  amountKopecks: number;
};

/** Топ сервисов по состоявшимся покупкам за период; кастомные заказы — одной строкой. */
export async function topServicesByPaidOrders(
  db: DB,
  range: AnalyticsRange,
  limit = 10,
): Promise<TopServiceRow[]> {
  const rows = await db.execute<{
    slug: string | null;
    title: string | null;
    orders: string | number;
    amount: string | number | null;
  }>(sql`
    SELECT s.slug, s.name AS title, count(*) AS orders, COALESCE(sum(o.amount_rub), 0) AS amount
    FROM orders o
    LEFT JOIN services s ON s.id = o.service_id
    WHERE o.status IN ${PURCHASED_STATUSES_SQL} AND ${withinRange(sql.raw('o.paid_at'), range)}
    GROUP BY s.slug, s.name
    ORDER BY orders DESC, amount DESC, s.slug ASC NULLS LAST
    LIMIT ${clampLimit(limit)}
  `);
  return rows.map((r) => ({
    serviceSlug: r.slug,
    title: r.title,
    orders: toInt(r.orders),
    amountKopecks: toInt(r.amount),
  }));
}

export type CatalogClicksRow = {
  serviceSlug: string;
  /** Имя из каталога; `null` — слаг, которого в каталоге уже нет. */
  title: string | null;
  clicks: number;
  subjects: number;
};

/**
 * Что смотрят в каталоге: события `service_click` по `props.slug` (так их
 * пишут `StartScreen` и `CatalogView`). Имя сервиса подтягивается по slug — у
 * события ссылки на каталог нет намеренно (архивный сервис остаётся в истории).
 */
export async function catalogClicksByService(
  db: DB,
  range: AnalyticsRange,
  limit = 10,
): Promise<CatalogClicksRow[]> {
  const rows = await db.execute<{
    slug: string;
    title: string | null;
    clicks: string | number;
    subjects: string | number;
  }>(sql`
    SELECT t.props ->> 'slug' AS slug, s.name AS title,
           count(*) AS clicks, count(DISTINCT t.subject_key) AS subjects
    FROM analytics_timeline t
    LEFT JOIN services s ON s.slug = t.props ->> 'slug'
    WHERE t.name = 'service_click'
      AND t.props ? 'slug'
      AND ${withinRange(sql.raw('t.occurred_at'), range)}
    GROUP BY 1, 2
    ORDER BY clicks DESC, subjects DESC, slug ASC
    LIMIT ${clampLimit(limit)}
  `);
  return rows.map((r) => ({
    serviceSlug: r.slug,
    title: r.title,
    clicks: toInt(r.clicks),
    subjects: toInt(r.subjects),
  }));
}

export type ActivityPoint = { day: string; subjects: number };

/** Активность по дням — distinct `subject_key` в день, нули заполнены. */
export async function activeSubjectsByDay(db: DB, range: AnalyticsRange): Promise<ActivityPoint[]> {
  const rows = await db.execute<{ day: string; subjects: string | number }>(sql`
    SELECT ${dayKeySql(sql.raw('t.occurred_at'))} AS day, count(DISTINCT t.subject_key) AS subjects
    FROM analytics_timeline t
    WHERE t.subject_key IS NOT NULL AND ${withinRange(sql.raw('t.occurred_at'), range)}
    GROUP BY 1
  `);
  const byDay = new Map(rows.map((r) => [r.day, toInt(r.subjects)]));
  return dayKeysInRange(range).map((day) => ({ day, subjects: byDay.get(day) ?? 0 }));
}

/** Потолок топов: экран читают глазами, «топ-1000» здесь бессмыслен. */
const MAX_TOP_ROWS = 50;
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 10;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_TOP_ROWS);
}
