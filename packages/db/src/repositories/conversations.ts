import { and, desc, eq, sql } from 'drizzle-orm';

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

  // «Найти или создать» без атомарности расщепляло историю: два сообщения,
  // пришедшие одновременно от нового пользователя (веб-вкладка + бот, дребезг
  // отправки), оба не находили диалога и создавали по своему — часть переписки
  // уезжала в осиротевший conversation, и агент терял контекст.
  //
  // Уникальный индекс на (user_id, channel) здесь НЕ подходит: несколько
  // диалогов на пару — это штатное поведение кнопки «Очистить диалог»
  // (см. `createConversation`). Поэтому сериализуем только путь создания —
  // транзакционным advisory-lock'ом по паре ключей. Он снимается сам на
  // COMMIT/ROLLBACK, не требует схемы и не мешает другим пользователям:
  // конкуренты за ДРУГИЕ пары проходят параллельно.
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${channel}))`,
    );

    const existing = await tx
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

    const inserted = await tx
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
  });
}

/**
 * Принудительно создать НОВЫЙ conversation (кнопка «Очистить диалог» в
 * веб-чате). Старый разговор не трогаем (append-only дух) — он просто
 * перестаёт быть активным: `getOrCreateActiveConversation` выбирает
 * последний по `created_at`.
 */
export async function createConversation(
  db: DB,
  input: GetOrCreateActiveConversationInput,
  log: RepoLogger = noopLogger,
): Promise<{ id: string }> {
  const { userId, channel } = input;
  const inserted = await db
    .insert(conversations)
    .values({ userId, channel })
    .returning({ id: conversations.id });

  const row = inserted[0];
  if (!row) {
    throw new Error('createConversation: INSERT не вернул строку (RETURNING пуст)');
  }

  log.info({
    event: 'db.conversations.created',
    conversationId: row.id,
    userId,
    channel,
    reason: 'manual_clear',
  });

  return { id: row.id };
}

/**
 * Read-only вариант: найти активный conversation без создания. Для
 * GET-эндпоинтов (история веб-чата) — открытие страницы не должно
 * порождать записи в БД.
 */
export async function findActiveConversation(
  db: DB,
  input: GetOrCreateActiveConversationInput,
): Promise<string | null> {
  const { userId, channel } = input;
  const existing = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.channel, channel)))
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  return existing[0]?.id ?? null;
}
