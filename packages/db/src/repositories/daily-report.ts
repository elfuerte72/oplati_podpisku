import { sql } from 'drizzle-orm';

import type { DB } from '../index.ts';
import type { AnalyticsRange } from './analytics-panel.ts';
import { toInt } from './pg-numbers.ts';

/**
 * Выборки дневного отчёта в тему «Отчёты» ops-группы (`lib/jobs/daily-report.ts`).
 *
 * Деньги и число покупок сюда НЕ входят: их считает `revenueSummary` — та же
 * функция, что питает раздел «Отчёты» панели. Второе определение выручки
 * разошлось бы с экраном на первом же оплаченном, но провалившемся заказе.
 *
 * Правила те же, что у `analytics-panel.ts`: окно полуоткрытое `[since, until)`,
 * границы — ISO-строки (НЕ `Date`: боевой postgres-js на `Date` в raw-`sql`
 * падает, а PGlite молчит — инцидент 2026-08-15), деньги — integer в копейках,
 * люди считаются по `subject_key` вьюхи `analytics_timeline` — второго
 * определения «человека» в проекте нет.
 */

function withinRange(column: ReturnType<typeof sql.raw>, range: AnalyticsRange) {
  return sql`${column} >= ${range.since}::timestamptz AND ${column} < ${range.until}::timestamptz`;
}

// ─── Аудитория ────────────────────────────────────────────────────────────

export type DailyAudience = {
  /** Людей с любым действием в боте или Mini App. */
  telegramVisitors: number;
  /** Из них нажали /start. */
  botStarts: number;
  /** Из них открыли кабинет (Mini App). */
  cabinetOpens: number;
  /** Людей с любым действием на сайте. */
  webVisitors: number;
  /** Новых клиентов Telegram — строк `users`, созданных за сутки. */
  newTelegramUsers: number;
  /** Закрепились за партнёром по реф-ссылке. */
  referralJoins: number;
};

/**
 * Кто заходил. Каналы — из собственной телеметрии (`kind = 'event'`): денежные
 * вехи во вьюхе помечены каналом `derived` и в «заходы» не входят — оплата без
 * единого открытия бота невозможна, а человек посчитался бы дважды.
 *
 * ⚠️ Нижняя оценка: сообщение в бот без /start и без кнопок телеметрией не
 * пишется (кроме `bot_text_ignored`), поэтому «заходил» — это «сделал что-то,
 * что мы видим».
 */
export async function dailyAudience(db: DB, range: AnalyticsRange): Promise<DailyAudience> {
  const rows = await db.execute<{
    telegram_visitors: string | number;
    bot_starts: string | number;
    cabinet_opens: string | number;
    web_visitors: string | number;
    new_users: string | number;
    referral_joins: string | number;
  }>(sql`
    WITH ev AS (
      SELECT t.subject_key, t.channel, t.name
      FROM analytics_timeline t
      WHERE t.kind = 'event'
        AND t.subject_key IS NOT NULL
        AND ${withinRange(sql.raw('t.occurred_at'), range)}
    )
    SELECT
      (SELECT count(DISTINCT subject_key) FROM ev WHERE channel IN ('bot', 'miniapp')) AS telegram_visitors,
      (SELECT count(DISTINCT subject_key) FROM ev WHERE name = 'bot_start') AS bot_starts,
      (SELECT count(DISTINCT subject_key) FROM ev WHERE name = 'cabinet_open') AS cabinet_opens,
      (SELECT count(DISTINCT subject_key) FROM ev WHERE channel = 'web') AS web_visitors,
      (SELECT count(*) FROM users
        WHERE telegram_id IS NOT NULL AND ${withinRange(sql.raw('created_at'), range)}) AS new_users,
      (SELECT count(*) FROM users
        WHERE referred_by IS NOT NULL AND ${withinRange(sql.raw('referred_by_set_at'), range)}) AS referral_joins
  `);
  const row = rows[0];
  return {
    telegramVisitors: toInt(row?.telegram_visitors),
    botStarts: toInt(row?.bot_starts),
    cabinetOpens: toInt(row?.cabinet_opens),
    webVisitors: toInt(row?.web_visitors),
    newTelegramUsers: toInt(row?.new_users),
    referralJoins: toInt(row?.referral_joins),
  };
}

// ─── Заказы ───────────────────────────────────────────────────────────────

export type DailyOrderFlow = {
  /** Оформлено заказов. */
  created: number;
  /** Выставлено счетов (заказов, по которым ушёл хотя бы один счёт). */
  invoiced: number;
  /** Истёк срок — не оплатили. */
  expired: number;
  /** Отменил клиент. */
  cancelled: number;
  /** Ушли в «Ошибку» (недоплата, отказ шлюза, сбой выпуска карты). */
  failed: number;
  /** Ушли «на проверку банка». */
  paymentReview: number;
};

/**
 * Движение заказов за сутки — из `order_events` (инвариант 1: журнал и есть
 * источник правды о переходах), а не из текущего статуса: заказ, созданный
 * вчера и истёкший сегодня, обязан попасть в сегодняшние «истекли».
 * Считаются заказы, а не события: повторный счёт по тому же заказу — один заказ.
 */
export async function dailyOrderFlow(db: DB, range: AnalyticsRange): Promise<DailyOrderFlow> {
  const rows = await db.execute<{
    created: string | number;
    invoiced: string | number;
    expired: string | number;
    cancelled: string | number;
    failed: string | number;
    review: string | number;
  }>(sql`
    SELECT
      count(DISTINCT order_id) FILTER (WHERE event_type = 'order_created') AS created,
      count(DISTINCT order_id) FILTER (WHERE event_type = 'payment_invoice_created') AS invoiced,
      count(DISTINCT order_id) FILTER (WHERE to_status = 'expired') AS expired,
      count(DISTINCT order_id) FILTER (WHERE to_status = 'cancelled') AS cancelled,
      count(DISTINCT order_id) FILTER (WHERE to_status = 'failed') AS failed,
      count(DISTINCT order_id) FILTER (WHERE to_status = 'payment_review') AS review
    FROM order_events
    WHERE ${withinRange(sql.raw('created_at'), range)}
  `);
  const row = rows[0];
  return {
    created: toInt(row?.created),
    invoiced: toInt(row?.invoiced),
    expired: toInt(row?.expired),
    cancelled: toInt(row?.cancelled),
    failed: toInt(row?.failed),
    paymentReview: toInt(row?.review),
  };
}

export type DailyPaidOrder = {
  shortId: string;
  paidAt: Date;
  /** Текущий статус: оплаченный заказ мог уже уйти в «Ошибку». */
  status: string;
  /** Полная цена заказа, копейки (`orders.amount_rub`). */
  amountKopecks: number;
  /**
   * Скидка, погашенная при оплате (промокод + баллы, строки `spent`), копейки.
   * Клиент заплатил `amountKopecks - discountKopecks`: без этого поля строка
   * «2 285 ₽» спорила бы с «Получено денег: 1 846 ₽» над ней.
   */
  discountKopecks: number;
  /** Имя сервиса из каталога; `null` — заказ вне каталога. */
  serviceName: string | null;
  tierName: string | null;
  /** Цена сервиса в его валюте (минимальные единицы) — различает тарифы, когда `tierName` не сохранён. */
  originalAmount: number | null;
  originalCurrency: string | null;
  customDescription: string | null;
  telegramUsername: string | null;
  displayName: string | null;
};

/** Потолок списка: сообщение Telegram — 4096 символов, а читают его глазами. */
export const DAILY_PAID_ORDERS_MAX = 30;

/**
 * Кто оплатил: заказы, по которым за сутки пришли деньги (`paid_at` ставит
 * переход в `paid`), В ЛЮБОМ текущем статусе — оплаченный, но не выданный
 * заказ в этом списке нужнее всего. Сортировка по времени оплаты.
 *
 * Отдаёт срез до `limit` строк и полное число, чтобы текст мог честно сказать
 * «и ещё N», а не молча обрезать список.
 */
export async function dailyPaidOrders(
  db: DB,
  range: AnalyticsRange,
  limit: number = DAILY_PAID_ORDERS_MAX,
): Promise<{ items: DailyPaidOrder[]; total: number }> {
  const capped = Math.min(Math.max(Math.floor(limit), 1), DAILY_PAID_ORDERS_MAX);
  const [rows, totals] = await Promise.all([
    db.execute<{
      short_id: string;
      paid_at: string | Date;
      status: string;
      amount_rub: string | number | null;
      discount: string | number | null;
      service_name: string | null;
      tier_name: string | null;
      original_amount: string | number | null;
      original_currency: string | null;
      custom_description: string | null;
      telegram_username: string | null;
      display_name: string | null;
    }>(sql`
      SELECT o.short_id, o.paid_at, o.status::text AS status, o.amount_rub,
             COALESCE((SELECT sum(pr.discount_kopecks) FROM promo_redemptions pr
                        WHERE pr.order_id = o.id AND pr.status = 'spent'), 0)
             + COALESCE((SELECT sum(rr.discount_kopecks) FROM referral_redemptions rr
                        WHERE rr.order_id = o.id AND rr.status = 'spent'), 0) AS discount,
             s.name AS service_name,
             o.parameters ->> 'tierName' AS tier_name,
             o.original_amount, o.original_currency,
             o.custom_service_description AS custom_description,
             u.telegram_username, u.display_name
      FROM orders o
      JOIN users u ON u.id = o.user_id
      LEFT JOIN services s ON s.id = o.service_id
      WHERE o.paid_at IS NOT NULL AND ${withinRange(sql.raw('o.paid_at'), range)}
      ORDER BY o.paid_at ASC, o.id ASC
      LIMIT ${capped}
    `),
    db.execute<{ total: string | number }>(sql`
      SELECT count(*) AS total FROM orders
      WHERE paid_at IS NOT NULL AND ${withinRange(sql.raw('paid_at'), range)}
    `),
  ]);
  return {
    items: rows.map((r) => ({
      shortId: r.short_id,
      paidAt: new Date(r.paid_at),
      status: r.status,
      amountKopecks: toInt(r.amount_rub),
      discountKopecks: toInt(r.discount),
      serviceName: r.service_name,
      tierName: r.tier_name,
      originalAmount: r.original_amount == null ? null : toInt(r.original_amount),
      originalCurrency: r.original_currency,
      customDescription: r.custom_description,
      telegramUsername: r.telegram_username,
      displayName: r.display_name,
    })),
    total: toInt(totals[0]?.total),
  };
}

export type PromoDiscounts = {
  /** Заказов, оплаченных со скидкой по промокоду. */
  orders: number;
  /** Сумма скидок по промокодам, копейки. */
  kopecks: number;
};

/**
 * Скидки по промокодам, погашенные за период — по моменту оплаты (`settled_at`
 * строки `spent`), тем же событием, которым платёж попадает в выручку. Пара к
 * `bonusRedeemedKopecks` из `revenueSummary`: без неё «Получено денег» ниже
 * суммы покупок читалось бы как недостача.
 *
 * ОБЩАЯ для утреннего отчёта (сутки) и раздела «Отчёты» панели (7/30/90 дней),
 * поэтому в имени «период», а не «сутки»: иначе следующий автор написал бы для
 * панели вторую выборку — зеркало, которое разъехалось бы в первом же отчёте о
 * выручке (тикет 05 аудита CRM).
 */
export async function promoDiscountsInPeriod(db: DB, range: AnalyticsRange): Promise<PromoDiscounts> {
  const rows = await db.execute<{ orders: string | number; kopecks: string | number | null }>(sql`
    SELECT count(DISTINCT order_id) AS orders, COALESCE(sum(discount_kopecks), 0) AS kopecks
    FROM promo_redemptions
    WHERE status = 'spent' AND ${withinRange(sql.raw('settled_at'), range)}
  `);
  return { orders: toInt(rows[0]?.orders), kopecks: toInt(rows[0]?.kopecks) };
}

// ─── Поддержка и обратная связь ───────────────────────────────────────────

export type DailySupport = {
  /** Людей, нажавших «Поддержка» (`support_requested`). */
  requests: number;
  /** Оценок заказа из воронки. */
  ratings: number;
  /** Средняя оценка, округлённая до десятых; `null` — оценок не было. */
  ratingAverage: number | null;
  /** Оценок 1–3 — по ним персонал уже получил отдельное уведомление. */
  lowRatings: number;
};

export async function dailySupport(db: DB, range: AnalyticsRange): Promise<DailySupport> {
  const rows = await db.execute<{
    requests: string | number;
    ratings: string | number;
    rating_avg: string | number | null;
    low_ratings: string | number;
  }>(sql`
    SELECT
      (SELECT count(DISTINCT t.subject_key) FROM analytics_timeline t
        WHERE t.kind = 'event' AND t.name = 'support_requested'
          AND ${withinRange(sql.raw('t.occurred_at'), range)}) AS requests,
      count(f.score) AS ratings,
      round(avg(f.score)::numeric, 1) AS rating_avg,
      count(f.score) FILTER (WHERE f.score <= 3) AS low_ratings
    FROM client_feedback f
    WHERE f.kind = 'order_rating' AND f.score IS NOT NULL
      AND ${withinRange(sql.raw('f.created_at'), range)}
  `);
  const row = rows[0];
  const ratings = toInt(row?.ratings);
  const avg = row?.rating_avg == null ? null : Number(row.rating_avg);
  return {
    requests: toInt(row?.requests),
    ratings,
    ratingAverage: ratings > 0 && avg !== null && Number.isFinite(avg) ? avg : null,
    lowRatings: toInt(row?.low_ratings),
  };
}
