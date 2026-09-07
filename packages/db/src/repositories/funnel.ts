import { and, count, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';

import { clientFeedback, conversations, funnelSends, orders, users } from '../schema.ts';
import type { DB, DBLike } from '../index.ts';
import { emitDbChange } from '../change-feed.ts';
import { funnelKind, type FunnelKind } from '@oplati/types';
import { clampPanelLimit, clampPanelOffset } from './panel.ts';

/**
 * Репозиторий воронки обратной связи (спека `.scratch/retention-funnel/`).
 *
 * Здесь живут ВСЕ SQL воронки: выборки для крон-джобы, атомарный claim
 * отправки, счётчики бюджета привратника и запись ответов клиента. Своих SQL
 * в `apps/web` у воронки нет (тикет 01).
 *
 * Дедуп рассылки держит claim (частичные UNIQUE в `funnel_sends`), а не
 * выборки: их окна ШИРЕ шага крона — событие попадает в выборку несколько
 * прогонов подряд, и это нормально. Окна одновременно дают но-бэкфилл:
 * событие СТАРШЕ окна не рассылается никогда, поэтому включение флага не
 * трогает существующую базу (история 16 спеки).
 */

const SELECTION_BATCH_LIMIT = 200;

// ─── Состояние пользователя для привратника ───────────────────────────────

export type FunnelUserState = {
  telegramId: string | null;
  funnelOptOutAt: Date | null;
};

/** Telegram-идентичность и отписка — первые проверки привратника. */
export async function getFunnelUserState(
  db: DBLike,
  userId: string,
): Promise<FunnelUserState | null> {
  const rows = await db
    .select({ telegramId: users.telegramId, funnelOptOutAt: users.funnelOptOutAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * «Больше не напоминать»: выставляет отметку отписки. Идемпотентно — первый
 * клик побеждает, повторный существующую отметку не сдвигает (момент отписки
 * не должен «омолаживаться»).
 */
export async function setFunnelOptOut(db: DBLike, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ funnelOptOutAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(users.id, userId), isNull(users.funnelOptOutAt)));
}

/**
 * Есть ли у клиента разговор в режиме оператора — поверх него воронка не
 * пишет никогда (история 9 спеки).
 *
 * Срок режима гаснет ЛЕНИВО (инвариант 5 трека support-ai): разговор с
 * истёкшим `mode_expires_at` в БД всё ещё `operator`, но фактически закрыт —
 * его добьёт крон хозяйства поддержки. Такой не блокирует. `NULL` в
 * `operator` — «ждём человека, не гаснет никогда» — блокирует.
 */
export async function hasActiveOperatorConversation(
  db: DBLike,
  userId: string,
  now: Date,
): Promise<boolean> {
  const nowIso = now.toISOString();
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, userId),
        eq(conversations.handoffMode, 'operator'),
        sql`(${conversations.modeExpiresAt} IS NULL OR ${conversations.modeExpiresAt} > ${nowIso}::timestamptz)`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ─── Бюджет и claim ───────────────────────────────────────────────────────

/** Сколько сообщений воронки ушло клиенту с момента `since` (скользящее окно). */
export async function countFunnelSendsSince(
  db: DBLike,
  userId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(funnelSends)
    .where(and(eq(funnelSends.userId, userId), gte(funnelSends.sentAt, since)));
  return rows[0]?.value ?? 0;
}

/** Когда клиенту в последний раз уходило сообщение этого вида (правило 90 дней у оценки). */
export async function getLastFunnelSendAt(
  db: DBLike,
  userId: string,
  kind: FunnelKind,
): Promise<Date | null> {
  const rows = await db
    .select({ sentAt: funnelSends.sentAt })
    .from(funnelSends)
    .where(and(eq(funnelSends.userId, userId), eq(funnelSends.kind, kind)))
    .orderBy(desc(funnelSends.sentAt))
    .limit(1);
  return rows[0]?.sentAt ?? null;
}

/**
 * Атомарно «занять» право отправить сообщение воронки — ПЕРЕД отправкой
 * (at-most-once, прецедент `claimRenewalReminder`). `false` — право занял
 * конкурент или сообщение уже уходило: не шлём.
 *
 * Арбитр конфликта — частичные UNIQUE `funnel_sends` (одноразовые kind'ы по
 * (user_id, kind), оценка — по order_id). `onConflictDoNothing` без target:
 * любой из них означает «уже занято».
 */
export async function claimFunnelSend(
  db: DBLike,
  input: { userId: string; kind: FunnelKind; orderId?: string | null },
): Promise<boolean> {
  // У оценки арбитр конфликта — частичный UNIQUE по order_id: строка БЕЗ него
  // не покрыта НИ ОДНИМ индексом, и такой claim всегда отвечал бы true —
  // повторные отправки сдерживал бы только бюджет (ось A full-review).
  // Ошибка программиста, не данных — поэтому throw, а не Result.
  if (input.kind === 'order_rating' && !input.orderId) {
    throw new Error('claimFunnelSend: kind=order_rating требует orderId (арбитр claim-а)');
  }
  const rows = await db
    .insert(funnelSends)
    .values({ userId: input.userId, kind: input.kind, orderId: input.orderId ?? null })
    .onConflictDoNothing()
    .returning({ id: funnelSends.id });
  return rows.length > 0;
}

// ─── Ответы клиента ───────────────────────────────────────────────────────

/**
 * Записать ответ клиента (ключ кнопки или оценку). `false` — ответ уже был:
 * первый клик побеждает, повторный не дублирует и не перезаписывает
 * (частичные UNIQUE `client_feedback`).
 */
export async function recordClientFeedback(
  db: DBLike,
  input: {
    userId: string;
    kind: FunnelKind;
    orderId?: string | null;
    score?: number | null;
    answer?: string | null;
  },
): Promise<boolean> {
  const rows = await db
    .insert(clientFeedback)
    .values({
      userId: input.userId,
      kind: input.kind,
      orderId: input.orderId ?? null,
      score: input.score ?? null,
      answer: input.answer ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: clientFeedback.id });
  const inserted = rows.length > 0;
  if (inserted) emitDbChange('client_feedback');
  return inserted;
}

// ─── Выборки крон-джобы ───────────────────────────────────────────────────
//
// Общие правила: окно [from, to) задаёт вызывающий (шире шага крона); время
// входа заказа в статус берётся из `order_events`, а не из полей заказа
// (прецедент `findStuckInFulfillmentOrders` — с ручной выдачей поля врут);
// строки без события перехода в окно не попадают вовсе — это и есть
// но-бэкфилл для заказов, живших до появления журнала. Даты — ISO-строками:
// postgres-js падает на `Date` в raw-`sql`-фрагменте (инцидент 2026-08-15).

export type FunnelWindow = { from: Date; to: Date };

/** NOT EXISTS «клиенту уже уходило сообщение вида» — общий кусок всех выборок. */
function noFunnelSendForUser(userIdExpr: SQL, kind: FunnelKind): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM funnel_sends fs
    WHERE fs.user_id = ${userIdExpr} AND fs.kind = ${kind}
  )`;
}

/**
 * «Заказ сейчас в статусе и ВОШЁЛ в него внутри окна» — время входа из
 * `order_events`, а не из полей заказа. Заказ без события перехода (данные
 * до появления журнала) не совпадает никогда — это и есть но-бэкфилл.
 */
function orderEnteredStatusInWindow(status: 'expired' | 'completed', window: FunnelWindow): SQL {
  const fromIso = window.from.toISOString();
  const toIso = window.to.toISOString();
  return sql`${orders.status} = ${status}
    AND (SELECT max(e.created_at) FROM order_events e
          WHERE e.order_id = ${orders.id} AND e.to_status = ${status})
        BETWEEN ${fromIso}::timestamptz AND ${toIso}::timestamptz`;
}

export type ExpiredOrderForSurvey = { orderId: string; userId: string };

/**
 * msg1: заказы, вошедшие в `expired` в окне, у чьих пользователей опрос ещё
 * не уходил. Один пользователь может дать несколько строк (два протухших
 * заказа в окне) — джоба дедупит в проходе, а страхует claim.
 */
export async function findExpiredOrdersForSurvey(
  db: DB,
  window: FunnelWindow,
): Promise<ExpiredOrderForSurvey[]> {
  const rows = await db
    .select({ orderId: orders.id, userId: orders.userId })
    .from(orders)
    .where(
      and(
        orderEnteredStatusInWindow('expired', window),
        noFunnelSendForUser(sql`${orders.userId}`, 'expired_survey'),
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(SELECTION_BATCH_LIMIT);
  return rows;
}

/**
 * msg2: telegram-пользователи, созданные в окне, без единого заказа и без
 * уже отправленного опроса. Отписанных выборка отсекает сразу — привратник
 * всё равно проверит, но гонять по ним цикл незачем.
 */
export async function findFreshUsersWithoutOrders(
  db: DB,
  window: FunnelWindow,
): Promise<{ userId: string }[]> {
  const rows = await db
    .select({ userId: users.id })
    .from(users)
    .where(
      and(
        sql`${users.telegramId} IS NOT NULL`,
        gte(users.createdAt, window.from),
        lte(users.createdAt, window.to),
        isNull(users.funnelOptOutAt),
        sql`NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = ${users.id})`,
        noFunnelSendForUser(sql`${users.id}`, 'start_survey'),
      ),
    )
    .limit(SELECTION_BATCH_LIMIT);
  return rows;
}

export type CompletedOrderForRating = {
  orderId: string;
  userId: string;
  serviceId: string | null;
};

/**
 * msg3: заказы, вошедшие в `completed` в окне, по которым оценка ещё не
 * спрашивалась. Правило частоты (первая оценка клиента / повтор не раньше
 * 90 дней) — в привратнике, не здесь; дедуп по ЗАКАЗУ, не по клиенту.
 */
export async function findCompletedOrdersForRating(
  db: DB,
  window: FunnelWindow,
): Promise<CompletedOrderForRating[]> {
  const rows = await db
    .select({ orderId: orders.id, userId: orders.userId, serviceId: orders.serviceId })
    .from(orders)
    .where(
      and(
        orderEnteredStatusInWindow('completed', window),
        sql`NOT EXISTS (
          SELECT 1 FROM funnel_sends fs
          WHERE fs.order_id = ${orders.id} AND fs.kind = 'order_rating'
        )`,
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(SELECTION_BATCH_LIMIT);
  return rows;
}

/**
 * msg4: клиенты с оценкой ≥4 в окне, которым реферальное касание ещё не
 * уходило (UNIQUE — раз за жизнь). Гейт `REFERRAL_ENABLED` — у вызывающего.
 */
export async function findRatedUsersForReferralNudge(
  db: DB,
  window: FunnelWindow,
): Promise<{ userId: string }[]> {
  const rows = await db
    .selectDistinct({ userId: clientFeedback.userId })
    .from(clientFeedback)
    .where(
      and(
        eq(clientFeedback.kind, 'order_rating'),
        gte(clientFeedback.score, 4),
        gte(clientFeedback.createdAt, window.from),
        lte(clientFeedback.createdAt, window.to),
        noFunnelSendForUser(sql`${clientFeedback.userId}`, 'referral_nudge'),
      ),
    )
    .limit(SELECTION_BATCH_LIMIT);
  return rows;
}

// ─── Read-side для панели: лента «Обратная связь» (панель v2, тикет 14) ────
//
// Границы окна — ISO-строки, не `Date` (raw-`sql` Drizzle роняет postgres-js
// на `Date`, PGlite молчит — инцидент 2026-08-15). Потолок страницы — общий
// `clampPanelLimit` панели: экран читают глазами, не выгружают.

export type PanelFeedbackRow = {
  id: string;
  createdAt: Date;
  kind: FunnelKind;
  score: number | null;
  answer: string | null;
  client: { id: string; displayName: string | null; telegramId: string | null };
  /** Заказ-триггер, если есть: у оценки всегда, у опроса протухшего — обычно. */
  order: { id: string; shortId: string; serviceName: string | null } | null;
};

/**
 * Лента ответов за период, новые сверху. «Есть ещё» — выборкой на строку больше
 * (как у остальных списков панели).
 */
export async function listClientFeedbackForPanel(
  db: DB,
  opts: { since: string; limit?: number; offset?: number },
): Promise<{ items: PanelFeedbackRow[]; hasMore: boolean }> {
  const maxRows = clampPanelLimit(opts.limit);
  const offset = clampPanelOffset(opts.offset);
  const rows = await db.execute<{
    id: string;
    created_at: string | Date;
    kind: string;
    score: number | null;
    answer: string | null;
    user_id: string;
    display_name: string | null;
    telegram_id: string | null;
    order_id: string | null;
    short_id: string | null;
    service_name: string | null;
    custom_description: string | null;
  }>(sql`
    SELECT f.id, f.created_at, f.kind, f.score, f.answer,
           u.id AS user_id, u.display_name, u.telegram_id,
           o.id AS order_id, o.short_id, s.name AS service_name,
           o.custom_service_description AS custom_description
    FROM client_feedback f
    JOIN users u ON u.id = f.user_id
    LEFT JOIN orders o ON o.id = f.order_id
    LEFT JOIN services s ON s.id = o.service_id
    WHERE f.created_at >= ${opts.since}::timestamptz
    ORDER BY f.created_at DESC, f.id DESC
    LIMIT ${maxRows + 1} OFFSET ${offset}
  `);
  const hasMore = rows.length > maxRows;
  const items = rows.slice(0, maxRows).map((r) => ({
    id: r.id,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    kind: r.kind as FunnelKind,
    score: r.score === null ? null : Number(r.score),
    answer: r.answer,
    client: { id: r.user_id, displayName: r.display_name, telegramId: r.telegram_id },
    order:
      r.order_id && r.short_id
        ? { id: r.order_id, shortId: r.short_id, serviceName: r.service_name ?? r.custom_description }
        : null,
  }));
  return { items, hasMore };
}

export type PanelFeedbackSummaryRow = {
  kind: FunnelKind;
  /**
   * Касаний этого вида за период — строк `funnel_sends`. Это ПОПЫТКИ, а не
   * доставленные сообщения: привратник занимает строку до отправки и не
   * снимает её ни при 403 «клиент заблокировал бота», ни при отказе Telegram.
   * Поля «доставлено» в таблице нет, поэтому витрина называет число касаниями.
   */
  sent: number;
  /** Ответов этого вида за период (`client_feedback`). */
  answered: number;
};

/**
 * Сводка по видам за период: касания / ответы. Доля считается на стороне
 * витрины (`null` при `sent = 0`). Строка на КАЖДЫЙ `funnelKind` из
 * `@oplati/types` (один источник списка), виды без событий — с нулями; у
 * реферального касания ответов нет по построению — витрина покажет прочерк.
 */
export async function feedbackSummaryForPanel(
  db: DB,
  opts: { since: string },
): Promise<PanelFeedbackSummaryRow[]> {
  const kinds = funnelKind.options;
  const rows = await db.execute<{ kind: string; sent: string | number; answered: string | number }>(sql`
    SELECT k.kind,
           (SELECT count(*) FROM funnel_sends fs
             WHERE fs.kind = k.kind AND fs.sent_at >= ${opts.since}::timestamptz) AS sent,
           (SELECT count(*) FROM client_feedback cf
             WHERE cf.kind = k.kind AND cf.created_at >= ${opts.since}::timestamptz) AS answered
    FROM (VALUES ${sql.join(
      kinds.map((k) => sql`(${k})`),
      sql`, `,
    )}) AS k(kind)
  `);
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return kinds.map((kind) => ({
    kind,
    sent: Number(byKind.get(kind)?.sent ?? 0),
    answered: Number(byKind.get(kind)?.answered ?? 0),
  }));
}

/** Ответов с момента `since` — для счётчика в меню (окно 24 ч задаёт вызывающий). */
export async function countRecentClientFeedbackForPanel(
  db: DB,
  opts: { since: string },
): Promise<number> {
  const rows = await db.execute<{ cnt: string | number }>(sql`
    SELECT count(*) AS cnt FROM client_feedback WHERE created_at >= ${opts.since}::timestamptz
  `);
  return Number(rows[0]?.cnt ?? 0);
}
