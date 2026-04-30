import { and, desc, eq } from 'drizzle-orm';

import { conversations } from '../schema.ts';
import type { DB } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Найти активный conversation для пары `(user_id, channel)` или создать новый.
 *
 * Стратегия: SELECT последнего по `created_at` → если есть, возвращаем; иначе INSERT.
 * Нет partial-unique по `(user_id, channel)` на этом milestone — допускается дубликат
 * при concurrent webhook'ах (на 50 заказов/день — пренебрежимо). Полный TTL/закрытие
 * conversation придёт в milestone «Handoff оператору».
 *
 * `handoff_mode` оставляем default `'ai'` — `assigned_operator_id` остаётся NULL.
 */

export type GetOrCreateActiveConversationInput = {
  userId: string;
  channel: 'telegram' | 'web';
};

export type GetOrCreateActiveConversationResult = {
  id: string;
  created: boolean;
};

export async function getOrCreateActiveConversation(
  db: DB,
  input: GetOrCreateActiveConversationInput,
  log: RepoLogger = noopLogger,
): Promise<GetOrCreateActiveConversationResult> {
  const { userId, channel } = input;

  log.debug({ event: 'db.conversations.lookup', userId, channel });

  const existing = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(eq(conversations.userId, userId), eq(conversations.channel, channel)),
    )
    .orderBy(desc(conversations.createdAt))
    .limit(1);

  const found = existing[0];
  if (found) {
    log.debug({
      event: 'db.conversations.resumed',
      conversationId: found.id,
      userId,
      channel,
    });
    return { id: found.id, created: false };
  }

  const inserted = await db
    .insert(conversations)
    .values({ userId, channel })
    .returning({ id: conversations.id });

  const row = inserted[0];
  if (!row) {
    throw new Error(
      'getOrCreateActiveConversation: INSERT не вернул строку (RETURNING пуст)',
    );
  }

  log.info({
    event: 'db.conversations.created',
    conversationId: row.id,
    userId,
    channel,
  });

  return { id: row.id, created: true };
}
