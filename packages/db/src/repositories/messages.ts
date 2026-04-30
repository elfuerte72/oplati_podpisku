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
