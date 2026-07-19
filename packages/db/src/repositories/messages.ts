import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { messages } from '../schema.ts';
import type { DB } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Append-only INSERT в `messages`. Содержимое (`content`) в логи НЕ попадает —
 * это PII. В логах только `messageId`, `conversationId`, `role`, `contentLength`.
 *
 * Инвариант `staffId required when role='operator'` (см. docs/database.md) на
 * этом milestone форсится только WARN'ом — UNIQUE/CHECK-constraint появится в
 * milestone «Handoff оператору» вместе с Zod-схемой границы.
 */

export type AppendMessageInput = {
  conversationId: string;
  role: 'user' | 'assistant' | 'operator' | 'system';
  content: string;
  staffId?: string | null;
  meta?: Record<string, unknown> | null;
};

export type AppendMessageResult = {
  id: string;
};

export async function appendMessage(
  db: DB,
  input: AppendMessageInput,
  log: RepoLogger = noopLogger,
): Promise<AppendMessageResult> {
  const { conversationId, role, content, staffId, meta } = input;

  if (role === 'operator' && !staffId) {
    log.warn({
      event: 'db.messages.operator_without_staff',
      conversationId,
      role,
    });
  }

  const inserted = await db
    .insert(messages)
    .values({
      conversationId,
      role,
      staffId: staffId ?? null,
      content,
      meta: meta ?? null,
    })
    .returning({ id: messages.id });

  const row = inserted[0];
  if (!row) {
    throw new Error('appendMessage: INSERT не вернул строку (RETURNING пуст)');
  }

  log.info({
    event: 'db.messages.persisted',
    messageId: row.id,
    conversationId,
    role,
    contentLength: content.length,
    hasMeta: meta !== null && meta !== undefined,
  });

  return { id: row.id };
}

export type MessageHistoryItem = {
  id: string;
  role: 'user' | 'assistant' | 'operator' | 'system';
  content: string;
  createdAt: Date;
};

/**
 * Возвращает последние N user/assistant сообщений диалога в **chronological**
 * порядке (старое → новое) — формат под Anthropic messages API.
 *
 * Operator-сообщения подаются в AI как `assistant`-роль (оператор пишет от
 * имени сервиса). System-сообщения и tool_use/tool_result в текущем milestone
 * не подгружаются — между turn'ами agent stateless относительно tool calls
 * (они есть только внутри одного turn'а).
 */
export async function loadRecentMessages(
  db: DB,
  conversationId: string,
  limit = 20,
  log: RepoLogger = noopLogger,
): Promise<MessageHistoryItem[]> {
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        inArray(messages.role, ['user', 'assistant', 'operator']),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  // SELECT с DESC + LIMIT даёт нам последние N. Разворачиваем в хронологию.
  const history: MessageHistoryItem[] = rows
    .map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      createdAt: r.createdAt,
    }))
    .reverse();

  log.debug({
    event: 'db.messages.history_loaded',
    conversationId,
    count: history.length,
  });

  return history;
}

/**
 * Возвращает `meta` последнего assistant-сообщения диалога (или `null`, если
 * сообщений нет или meta пустой).
 *
 * Нужно Telegram-боту для лёгкого pending-state кнопочного флоу: при выборе
 * сервиса без фиксированных тарифов (custom-amount) бот кладёт в meta
 * assistant-сообщения флаг «жду сумму для slug», а при следующем текстовом
 * сообщении читает его этой функцией — без отдельной таблицы состояния.
 * Состояние самосбрасывается: любой новый assistant-ответ (например, от агента)
 * становится последним и затирает флаг.
 */
export async function getLastAssistantMessageMeta(
  db: DB,
  conversationId: string,
  log: RepoLogger = noopLogger,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select({ meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'assistant')))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  const row = rows[0];
  log.debug({
    event: 'db.messages.last_assistant_meta',
    conversationId,
    found: Boolean(row),
  });
  return row?.meta ?? null;
}

// keep these imports referenced so tsc with verbatimModuleSyntax doesn't drop them
void asc;
void sql;

/**
 * Retention (M-13 аудита): удаление переписки старше `olderThanDays` батчами
 * по `limit` строк (cron `retention`, решение владельца 2026-07-19 — 90 дней).
 * История заказов/событий не затрагивается — это отдельные append-only таблицы.
 * Возвращает число удалённых строк (0 — чистить нечего, cron останавливается).
 */
export async function deleteOldMessages(
  db: DB,
  input: { olderThanDays: number; limit: number },
  log: RepoLogger = noopLogger,
): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    DELETE FROM ${messages}
    WHERE ${messages.id} IN (
      SELECT ${messages.id} FROM ${messages}
      WHERE ${messages.createdAt} < now() - make_interval(days => ${input.olderThanDays})
      ORDER BY ${messages.createdAt} ASC
      LIMIT ${input.limit}
    )
    RETURNING ${messages.id} AS id
  `);
  const deleted = rows.length;
  if (deleted > 0) {
    log.info({ event: 'db.messages.retention_deleted', deleted, olderThanDays: input.olderThanDays });
  }
  return deleted;
}
