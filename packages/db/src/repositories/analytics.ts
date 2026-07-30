import { sql } from 'drizzle-orm';

import { analyticsEventTypes, analyticsEvents } from '../schema.ts';
import type { DB } from '../index.ts';
import type { RepoLogger } from './logger.ts';

/**
 * Репозиторий поведенческой аналитики (`analytics_events`).
 *
 * Только наблюдения за поведением: клики, открытия, отвалы. Денежные вехи сюда
 * НЕ пишутся — они уже в `order_events` в одной транзакции с деньгами
 * (инвариант 1), отчёт подмешивает их вьюхой `analytics_timeline`.
 *
 * Личность в строке не хранится: держим identity канала (`web_session_id` из
 * cookie, `telegram_id`), а `user_id` резолвится JOIN'ом при чтении. Поэтому
 * merge пользователей в `consumeLinkToken` эту таблицу не трогает — и не может
 * забыть её тронуть.
 */

export type AnalyticsEventInsert = {
  eventKey: string;
  name: string;
  channel: string;
  origin: 'client' | 'server';
  webSessionId?: string | null;
  telegramId?: string | null;
  orderId?: string | null;
  props?: Record<string, string | number | boolean> | null;
  occurredAt: Date;
};

/**
 * Записать пачку событий. Идемпотентно по `event_key`: повтор sendBeacon и
 * двойной клик не удваивают воронку. Возвращает число реально вставленных.
 *
 * Не бросает на конфликте — но бросает на недоступной БД: обёртка `track()`
 * в apps/web гасит это, здесь глотать ошибку нельзя (репозиторий не знает,
 * критичен ли вызов).
 */
export async function insertAnalyticsEvents(
  db: DB,
  events: AnalyticsEventInsert[],
): Promise<number> {
  if (events.length === 0) return 0;

  const rows = await db
    .insert(analyticsEvents)
    .values(
      events.map((e) => ({
        eventKey: e.eventKey,
        name: e.name,
        channel: e.channel,
        origin: e.origin,
        webSessionId: e.webSessionId ?? null,
        telegramId: e.telegramId ?? null,
        orderId: e.orderId ?? null,
        props: e.props ?? null,
        occurredAt: e.occurredAt,
      })),
    )
    .onConflictDoNothing({ target: analyticsEvents.eventKey })
    .returning({ id: analyticsEvents.id });

  return rows.length;
}

export type AnalyticsDictionaryRow = {
  name: string;
  title: string;
  description: string;
  channel: string;
  origin: string;
  funnelStep: number | null;
  kind: string;
};

/**
 * Синхронизировать справочник подписей со словарём из кода.
 *
 * Идемпотентный upsert, а НЕ миграция: миграции у нас применяются вручную
 * после деплоя, и отчёты не должны зависеть от того, выполнил ли кто-то этот
 * шаг. Строки, исчезнувшие из кода, НЕ удаляются — исторические события в
 * таблице остаются, и их подписи должны продолжать резолвиться.
 */
export async function syncAnalyticsDictionary(
  db: DB,
  rows: AnalyticsDictionaryRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  await db
    .insert(analyticsEventTypes)
    .values(rows)
    .onConflictDoUpdate({
      target: analyticsEventTypes.name,
      set: {
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        channel: sql`excluded.channel`,
        origin: sql`excluded.origin`,
        funnelStep: sql`excluded.funnel_step`,
        kind: sql`excluded.kind`,
        updatedAt: sql`now()`,
      },
    });

  return rows.length;
}

/**
 * Удалить события старше N дней (cron `retention`, батчами).
 *
 * DELETE здесь разрешён — в отличие от `order_events`, где append-only-триггер
 * запрещает и UPDATE, и DELETE: аудит-след денег не чистится никогда, а
 * телеметрия обязана иметь срок жизни.
 */
export async function deleteOldAnalyticsEvents(
  db: DB,
  params: { olderThanDays: number; limit: number },
  log?: RepoLogger,
): Promise<number> {
  const cutoff = new Date(Date.now() - params.olderThanDays * 24 * 60 * 60 * 1000);

  const deleted = await db.execute<{ id: string }>(sql`
    DELETE FROM analytics_events
    WHERE id IN (
      SELECT id FROM analytics_events
      WHERE occurred_at < ${cutoff.toISOString()}
      ORDER BY occurred_at
      LIMIT ${params.limit}
    )
    RETURNING id
  `);

  const count = deleted.length;
  if (count > 0) {
    log?.info({ event: 'db.analytics.retention.deleted', count, olderThanDays: params.olderThanDays });
  }
  return count;
}

/** Диагностика: сколько событий накоплено и когда последнее (смоук после деплоя). */
export async function analyticsEventsStats(
  db: DB,
): Promise<{ total: number; lastAt: Date | null }> {
  const rows = await db.execute<{ total: string; last_at: Date | null }>(sql`
    SELECT count(*)::text AS total, max(occurred_at) AS last_at FROM analytics_events
  `);
  const row = rows[0];
  return {
    total: row ? Number(row.total) : 0,
    lastAt: row?.last_at ?? null,
  };
}

/** Хелпер для тестов/скриптов: события конкретного telegram-аккаунта. */
export async function countAnalyticsEventsByTelegramId(
  db: DB,
  telegramId: string,
): Promise<number> {
  const rows = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM analytics_events WHERE telegram_id = ${telegramId}
  `);
  return rows[0] ? Number(rows[0].count) : 0;
}
