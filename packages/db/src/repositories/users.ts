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
  /**
   * Реферер (id пригласившего партнёра). Проставляется ТОЛЬКО при создании
   * строки — `ON CONFLICT DO UPDATE` его не трогает (immutable + только-при-
   * создании, см. D-REF-9). Резолвится из deep-link `ref_<code>` до вызова.
   */
  referredBy?: string | null;
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
  const { telegramId, displayName, language, referredBy } = input;
  const telegramIdHash = hashTelegramId(telegramId);
  const startedAt = Date.now();

  log.debug({
    event: 'db.users.upsert.start',
    telegramIdHash,
    hasDisplayName: displayName !== undefined && displayName !== null,
    hasReferrer: referredBy !== undefined && referredBy !== null,
    language: language ?? 'ru',
  });

  // referred_by — только в INSERT-ветке; DO UPDATE его не упоминает, поэтому при
  // повторном /start (ON CONFLICT) реферер существующего юзера не перезаписывается.
  const rows = await db.execute<{ id: string; created: boolean }>(sql`
    INSERT INTO users (telegram_id, display_name, language, referred_by, referred_by_set_at)
    VALUES (
      ${telegramId},
      ${displayName ?? null},
      ${language ?? 'ru'},
      ${referredBy ?? null},
      ${referredBy ? new Date() : null}
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

/**
 * Upsert пользователя по `web_session_id` (веб-чат без регистрации).
 *
 * Зеркало `getOrCreateUserByTelegramId`: один INSERT с
 * `ON CONFLICT (web_session_id) WHERE web_session_id IS NOT NULL DO UPDATE`
 * против partial-unique индекса `users_web_session_id_idx`. `web_session_id`
 * приходит из httpOnly-cookie `session` (UUID v4, см. docs/web-chat.md).
 *
 * PII в логах: `web_session_id` хэшируется (sha256, первые 8 hex).
 */

export type GetOrCreateUserByWebSessionIdInput = {
  webSessionId: string;
  language?: string;
  /** Реферер — только при создании строки (immutable), см. телеграм-аналог. */
  referredBy?: string | null;
};

export type GetOrCreateUserByWebSessionIdResult = {
  id: string;
  created: boolean;
};

export async function getOrCreateUserByWebSessionId(
  db: DB,
  input: GetOrCreateUserByWebSessionIdInput,
  log: RepoLogger = noopLogger,
): Promise<GetOrCreateUserByWebSessionIdResult> {
  const { webSessionId, language, referredBy } = input;
  const sessionHash = hashSessionId(webSessionId);
  const startedAt = Date.now();

  log.debug({
    event: 'db.users.web.upsert.start',
    sessionHash,
    hasReferrer: referredBy !== undefined && referredBy !== null,
    language: language ?? 'ru',
  });

  const rows = await db.execute<{ id: string; created: boolean }>(sql`
    INSERT INTO users (web_session_id, language, referred_by, referred_by_set_at)
    VALUES (
      ${webSessionId}, ${language ?? 'ru'}, ${referredBy ?? null},
      ${referredBy ? new Date() : null}
    )
    ON CONFLICT (web_session_id) WHERE web_session_id IS NOT NULL
    DO UPDATE SET updated_at = now()
    RETURNING id, (xmax = 0) AS created
  `);

  const row = rows[0];
  if (!row) {
    throw new Error('getOrCreateUserByWebSessionId: empty RETURNING — INSERT/UPSERT не вернул строку');
  }

  const result: GetOrCreateUserByWebSessionIdResult = { id: row.id, created: row.created };

  if (result.created) {
    log.info({ event: 'db.users.web.created', sessionHash, userId: result.id });
  }

  log.debug({
    event: 'db.users.web.upsert.done',
    sessionHash,
    userId: result.id,
    created: result.created,
    durationMs: Date.now() - startedAt,
  });

  return result;
}

function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
}

/**
 * Привязана ли веб-сессия к Telegram — для поллинга статуса привязки
 * (`GET /api/auth/telegram/link/status`) и гейта перед оплатой.
 * Read-only: пользователя не создаёт.
 */
export async function isWebSessionLinkedToTelegram(
  db: DB,
  webSessionId: string,
): Promise<boolean> {
  const rows = await db.execute<{ telegram_id: string | null }>(
    sql`SELECT telegram_id FROM users WHERE web_session_id = ${webSessionId} LIMIT 1`,
  );
  return (rows[0]?.telegram_id ?? null) !== null;
}

/**
 * Профиль веб-сессии для правой панели сайта: имя (из Telegram после
 * привязки), статус привязки и реальная статистика покупок из `orders`.
 * «Покупка» = заказ, дошедший до оплаты: paid / in_fulfillment / completed.
 * Read-only: пользователя не создаёт; для незнакомой сессии — нули.
 */

export type WebSessionProfile = {
  displayName: string | null;
  telegramLinked: boolean;
  ordersCount: number;
  totalSpentKopecks: number;
};

export async function getWebSessionProfile(
  db: DB,
  webSessionId: string,
): Promise<WebSessionProfile> {
  const rows = await db.execute<{
    display_name: string | null;
    telegram_id: string | null;
    orders_count: number;
    // ::bigint приходит из драйвера строкой — Number() при маппинге.
    total_spent_kopecks: string | number;
  }>(sql`
    SELECT
      u.display_name,
      u.telegram_id,
      COUNT(o.id) FILTER (WHERE o.status IN ('paid', 'in_fulfillment', 'completed'))::int
        AS orders_count,
      COALESCE(
        SUM(o.amount_rub) FILTER (WHERE o.status IN ('paid', 'in_fulfillment', 'completed')),
        0
      )::bigint AS total_spent_kopecks
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id
    WHERE u.web_session_id = ${webSessionId}
    GROUP BY u.id
  `);

  const row = rows[0];
  if (!row) {
    return { displayName: null, telegramLinked: false, ordersCount: 0, totalSpentKopecks: 0 };
  }
  return {
    displayName: row.display_name,
    telegramLinked: row.telegram_id !== null,
    ordersCount: row.orders_count,
    totalSpentKopecks: Number(row.total_spent_kopecks),
  };
}

/**
 * Профиль пользователя по `user.id` — для шапки личного кабинета (Mini App).
 * Личность уже установлена проверенным initData, поэтому ходим по `id`. Read-only.
 */

export type UserProfile = {
  displayName: string | null;
  phone: string | null;
  email: string | null;
  telegramLinked: boolean;
  createdAt: Date;
};

export async function getUserProfileById(
  db: DB,
  userId: string,
): Promise<UserProfile | null> {
  const rows = await db.execute<{
    display_name: string | null;
    phone: string | null;
    email: string | null;
    telegram_id: string | null;
    created_at: string;
  }>(
    sql`SELECT display_name, phone, email, telegram_id, created_at
        FROM users WHERE id = ${userId} LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    displayName: row.display_name,
    phone: row.phone,
    email: row.email,
    telegramLinked: row.telegram_id !== null,
    createdAt: new Date(row.created_at),
  };
}

/**
 * Read-only поиск пользователя по `web_session_id` — для GET-эндпоинтов
 * (восстановление истории веб-чата), где создавать user нельзя
 * (инвариант: запись появляется только при первом сообщении).
 */
export async function findUserIdByWebSessionId(
  db: DB,
  webSessionId: string,
): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE web_session_id = ${webSessionId} LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}
