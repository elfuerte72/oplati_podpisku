import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { DB } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Upsert пользователя по `telegram_id`.
 *
 * Стратегия: один INSERT с `ON CONFLICT (telegram_id) WHERE telegram_id IS NOT NULL
 * DO UPDATE`. `display_name` обновляется через `COALESCE(EXCLUDED, existing)` —
 * пустой Telegram-апдейт (если у пользователя нет `first_name`) не перезаписывает
 * уже сохранённое имя. `xmax = 0` — Postgres-трюк для отличия INSERT от UPDATE
 * в `RETURNING`: при чистом INSERT `xmax = 0`, при UPDATE через ON CONFLICT —
 * содержит id транзакции.
 *
 * Используется raw SQL (а не drizzle-builder), потому что
 * `pgTable.uniqueIndex(...).where(...)` (partial unique) на момент drizzle-orm 0.45
 * требует ручной проверки `targetWhere` в `onConflictDoUpdate`. Raw SQL — детерминирован,
 * совместим с `prepare=false` (Supabase pooler в transaction mode).
 *
 * PII в логах: `telegram_id` хэшируется (sha256, первые 8 hex-символов) — это
 * требование `docs/security.md` / `docs/observability.md`.
 */

export type GetOrCreateUserByTelegramIdInput = {
  telegramId: string;
  displayName?: string | null;
  language?: string;
};

export type GetOrCreateUserByTelegramIdResult = {
  id: string;
  created: boolean;
};

export async function getOrCreateUserByTelegramId(
  db: DB,
  input: GetOrCreateUserByTelegramIdInput,
  log: RepoLogger = noopLogger,
): Promise<GetOrCreateUserByTelegramIdResult> {
  const { telegramId, displayName, language } = input;
  const telegramIdHash = hashTelegramId(telegramId);
  const startedAt = Date.now();

  log.debug({
    event: 'db.users.upsert.start',
    telegramIdHash,
    hasDisplayName: displayName !== undefined && displayName !== null,
    language: language ?? 'ru',
  });

  const rows = await db.execute<{ id: string; created: boolean }>(sql`
    INSERT INTO users (telegram_id, display_name, language)
    VALUES (
      ${telegramId},
      ${displayName ?? null},
      ${language ?? 'ru'}
    )
    ON CONFLICT (telegram_id) WHERE telegram_id IS NOT NULL
    DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, users.display_name),
      updated_at = now()
    RETURNING id, (xmax = 0) AS created
  `);

  const row = rows[0];
  if (!row) {
    throw new Error('getOrCreateUserByTelegramId: empty RETURNING — INSERT/UPSERT не вернул строку');
  }

  const result: GetOrCreateUserByTelegramIdResult = {
    id: row.id,
    created: row.created,
  };

  if (result.created) {
    log.info({
      event: 'db.users.created',
      telegramIdHash,
      userId: result.id,
    });
  }

  log.debug({
    event: 'db.users.upsert.done',
    telegramIdHash,
    userId: result.id,
    created: result.created,
    durationMs: Date.now() - startedAt,
  });

  return result;
}

function hashTelegramId(telegramId: string): string {
  return createHash('sha256').update(telegramId).digest('hex').slice(0, 8);
}

/**
 * Резолв `telegram_id` пользователя по `user.id` — нужен для отправки реквизитов
 * карты после `issue-card` (см. apps/web/lib/jobs/issue-card.ts).
 */
export async function getUserTelegramId(db: DB, userId: string): Promise<string | null> {
  const rows = await db.execute<{ telegram_id: string | null }>(
    sql`SELECT telegram_id FROM users WHERE id = ${userId} LIMIT 1`,
  );
  return rows[0]?.telegram_id ?? null;
}
