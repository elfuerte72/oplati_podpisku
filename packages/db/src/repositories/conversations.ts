import { and, desc, eq, sql } from 'drizzle-orm';

import { conversations } from '../schema.ts';
import type { DB, DBLike } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Найти активный conversation для пары `(user_id, channel)` или создать новый.
 *
 * Стратегия — двойная проверка: SELECT последнего по `created_at` без
 * транзакции (быстрый путь, он же почти все вызовы), а если диалога нет —
 * транзакция с advisory-lock'ом по паре ключей, повторный SELECT под ней и
 * INSERT. Прежняя схема без блокировки допускала дубликат при одновременных
 * webhook'ах, и часть переписки уезжала в осиротевший conversation.
 * Полный TTL/закрытие conversation придёт в milestone «Handoff оператору».
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

/**
 * Самый свежий диалог пары (user, channel) или null. Вынесено, чтобы быстрый
 * путь и повторная проверка под блокировкой не разъехались в условиях.
 */
async function selectLatest(
  db: DBLike,
  userId: string,
  channel: 'telegram' | 'web',
): Promise<string | null> {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.channel, channel)))
    // Тай-брейкер по id обязателен: на совпадении `created_at` (у настоящего
    // Postgres микросекунды, но ничья теоретически возможна) порядок без него
    // произволен, и «Очистить диалог» молча возвращал бы старую переписку.
    .orderBy(desc(conversations.createdAt), desc(conversations.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function getOrCreateActiveConversation(
  db: DB,
  input: GetOrCreateActiveConversationInput,
  log: RepoLogger = noopLogger,
): Promise<GetOrCreateActiveConversationResult> {
  const { userId, channel } = input;

  log.debug({ event: 'db.conversations.lookup', userId, channel });

  // Быстрый путь БЕЗ транзакции — он же подавляющее большинство вызовов: у
  // существующего пользователя диалог уже есть, и на каждое сообщение открывать
  // транзакцию с блокировкой значило бы платить лишними round-trip'ами
  // (BEGIN + lock + SELECT + COMMIT вместо одного SELECT) на самом горячем пути
  // бота и веб-чата. Гонка здесь невозможна по определению: раз строка уже
  // найдена, создавать нечего.
  const fastPath = await selectLatest(db, userId, channel);
  if (fastPath) {
    log.debug({ event: 'db.conversations.resumed', conversationId: fastPath, userId, channel });
    return { id: fastPath, created: false };
  }

  // Медленный путь — только первое сообщение пользователя в этом канале.
  //
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

    // Повторная проверка ПОД блокировкой обязательна: пока мы её ждали,
    // победитель гонки уже мог создать диалог. Без неё двойная проверка
    // выродилась бы в ту же гонку, только с лишним запросом.
    const found = await selectLatest(tx, userId, channel);
    if (found) {
      log.debug({
        event: 'db.conversations.resumed',
        conversationId: found,
        userId,
        channel,
      });
      return { id: found, created: false };
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
