import { createHash, randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { shouldInheritReferrerOnMerge } from '@oplati/types';

import type { DB } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Привязка Telegram-аккаунта к веб-сессии через одноразовый deep-link токен.
 *
 * Flow: сайт создаёт токен по `web_session_id` (`createLinkToken`) → пользователь
 * открывает `t.me/<bot>?start=link_<token>` → бот получает `/start link_<token>`
 * и вызывает `consumeLinkToken` → telegram_id и web_session_id оказываются на
 * одной строке `users`.
 *
 * Самый тонкий кейс — merge: пользователь уже платил в боте (есть строка с
 * `telegram_id`) И успел пописать в веб-чат (есть анонимная строка с
 * `web_session_id`). Выживает telegram-строка (на ней история заказов из бота),
 * children анонимной строки (conversations/orders/cards/attachments) переносятся
 * на неё, анонимная строка удаляется — всё в одной транзакции.
 * `order_events` append-only — их не трогаем (actor_id без FK, исторические
 * события остаются как есть).
 *
 * PII: telegram_id/web_session_id в логах только хэшем (sha256, 8 hex) — тот же
 * паттерн, что в users.ts.
 */

const TOKEN_TTL_MINUTES = 10;

/** Payload deep-link в Telegram ограничен 64 символами [A-Za-z0-9_-]. */
export const LINK_TOKEN_PREFIX = 'link_';

export type CreateLinkTokenInput = { webSessionId: string };
export type CreateLinkTokenResult = { token: string; expiresAt: Date };

export async function createLinkToken(
  db: DB,
  input: CreateLinkTokenInput,
  log: RepoLogger = noopLogger,
): Promise<CreateLinkTokenResult> {
  // 16 байт → 32 hex-символа; с префиксом "link_" = 37 ≤ 64 (лимит Telegram).
  const token = randomBytes(16).toString('hex');

  const rows = await db.execute<{ expires_at: Date }>(sql`
    INSERT INTO link_tokens (token, web_session_id, expires_at)
    VALUES (${token}, ${input.webSessionId}, now() + make_interval(mins => ${TOKEN_TTL_MINUTES}))
    RETURNING expires_at
  `);

  const row = rows[0];
  if (!row) {
    throw new Error('createLinkToken: empty RETURNING — INSERT не вернул строку');
  }

  log.info({
    event: 'db.link_tokens.created',
    sessionHash: hash8(input.webSessionId),
    ttlMinutes: TOKEN_TTL_MINUTES,
  });

  return { token, expiresAt: new Date(row.expires_at) };
}

export type ConsumeLinkTokenInput = {
  token: string;
  telegramId: string;
  displayName?: string | null;
};

export type ConsumeLinkTokenResult =
  | { ok: true; userId: string; merged: boolean; alreadyLinked: boolean }
  | { ok: false; reason: 'invalid_or_expired' };

export async function consumeLinkToken(
  db: DB,
  input: ConsumeLinkTokenInput,
  log: RepoLogger = noopLogger,
): Promise<ConsumeLinkTokenResult> {
  const { token, telegramId, displayName } = input;
  const telegramIdHash = hash8(telegramId);

  return await db.transaction(async (tx) => {
    // FOR UPDATE — два одновременных /start с одним токеном не пройдут оба.
    const tokenRows = await tx.execute<{
      id: string;
      web_session_id: string;
      expired_or_used: boolean;
    }>(sql`
      SELECT id, web_session_id, (used_at IS NOT NULL OR expires_at < now()) AS expired_or_used
      FROM link_tokens
      WHERE token = ${token}
      FOR UPDATE
    `);

    const tokenRow = tokenRows[0];
    if (!tokenRow || tokenRow.expired_or_used) {
      log.warn({
        event: 'db.link_tokens.consume.rejected',
        telegramIdHash,
        reason: tokenRow ? 'expired_or_used' : 'not_found',
      });
      return { ok: false, reason: 'invalid_or_expired' } as const;
    }

    const webSessionId = tokenRow.web_session_id;
    const sessionHash = hash8(webSessionId);

    await tx.execute(sql`
      UPDATE link_tokens
      SET used_at = now(), telegram_id = ${telegramId}
      WHERE id = ${tokenRow.id}
    `);

    // Обе строки под замком на время связывания (защита от гонки с parallel upsert).
    const userRows = await tx.execute<{
      id: string;
      telegram_id: string | null;
      web_session_id: string | null;
      referred_by: string | null;
    }>(sql`
      SELECT id, telegram_id, web_session_id, referred_by
      FROM users
      WHERE telegram_id = ${telegramId} OR web_session_id = ${webSessionId}
      FOR UPDATE
    `);

    const byTelegram = userRows.find((u) => u.telegram_id === telegramId) ?? null;
    const byWebSession = userRows.find((u) => u.web_session_id === webSessionId) ?? null;

    // Уже связаны — идемпотентный успех.
    if (byTelegram && byWebSession && byTelegram.id === byWebSession.id) {
      log.info({ event: 'db.link_tokens.consume.already_linked', telegramIdHash, sessionHash });
      return { ok: true, userId: byTelegram.id, merged: false, alreadyLinked: true } as const;
    }

    let merged = false;
    let targetUserId: string;

    if (byTelegram) {
      if (byWebSession) {
        if (byWebSession.telegram_id === null) {
          // Полный merge: выживает telegram-строка, children анонимной переезжают.
          await tx.execute(
            sql`UPDATE conversations SET user_id = ${byTelegram.id} WHERE user_id = ${byWebSession.id}`,
          );
          await tx.execute(
            sql`UPDATE orders SET user_id = ${byTelegram.id} WHERE user_id = ${byWebSession.id}`,
          );
          await tx.execute(
            sql`UPDATE cards SET user_id = ${byTelegram.id} WHERE user_id = ${byWebSession.id}`,
          );
          await tx.execute(
            sql`UPDATE attachments SET uploaded_by = ${byTelegram.id} WHERE uploaded_by = ${byWebSession.id}`,
          );
          // Реферальная сеть переживает merge (иначе референс терялся бы при DELETE
          // через onDelete: set null). (1) Реферер удаляемой web-строки наследуется
          // telegram-строкой, если у неё его ещё нет; (2) рефералы, указывавшие на
          // web-строку, переезжают на telegram-строку. Оба шага исключают самореферал.
          // referred_by мог появиться на web-строке при веб-захвате `?ref=` до привязки.
          if (
            shouldInheritReferrerOnMerge(
              byTelegram.referred_by,
              byWebSession.referred_by,
              byTelegram.id,
            )
          ) {
            await tx.execute(
              sql`UPDATE users SET referred_by = ${byWebSession.referred_by}, updated_at = now() WHERE id = ${byTelegram.id}`,
            );
          }
          await tx.execute(
            sql`UPDATE users SET referred_by = ${byTelegram.id}, updated_at = now() WHERE referred_by = ${byWebSession.id} AND id <> ${byTelegram.id}`,
          );
          await tx.execute(sql`DELETE FROM users WHERE id = ${byWebSession.id}`);
          merged = true;
        } else {
          // Веб-сессия числится за ДРУГИМ telegram-аккаунтом: его историю не
          // трогаем, просто отвязываем сессию (у строки остаётся telegram_id —
          // check-констрейнт identity_present не нарушается).
          await tx.execute(
            sql`UPDATE users SET web_session_id = NULL, updated_at = now() WHERE id = ${byWebSession.id}`,
          );
        }
      }
      // Привязываем сессию к telegram-строке (перезатирая возможную старую
      // сессию другого браузера — последняя привязка побеждает).
      await tx.execute(sql`
        UPDATE users
        SET web_session_id = ${webSessionId},
            display_name = COALESCE(users.display_name, ${displayName ?? null}),
            updated_at = now()
        WHERE id = ${byTelegram.id}
      `);
      targetUserId = byTelegram.id;
    } else if (byWebSession && byWebSession.telegram_id === null) {
      // Анонимный веб-пользователь, telegram-строки нет — тривиальный UPDATE.
      await tx.execute(sql`
        UPDATE users
        SET telegram_id = ${telegramId},
            display_name = COALESCE(users.display_name, ${displayName ?? null}),
            updated_at = now()
        WHERE id = ${byWebSession.id}
      `);
      targetUserId = byWebSession.id;
    } else {
      // Сессия свободна (или числится за другим telegram) и такого telegram_id
      // ещё нет — создаём пользователя сразу с обеими идентичностями.
      if (byWebSession) {
        await tx.execute(
          sql`UPDATE users SET web_session_id = NULL, updated_at = now() WHERE id = ${byWebSession.id}`,
        );
      }
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO users (telegram_id, web_session_id, display_name)
        VALUES (${telegramId}, ${webSessionId}, ${displayName ?? null})
        RETURNING id
      `);
      const insertedRow = inserted[0];
      if (!insertedRow) {
        throw new Error('consumeLinkToken: empty RETURNING при создании пользователя');
      }
      targetUserId = insertedRow.id;
    }

    log.info({
      event: 'db.link_tokens.consume.ok',
      telegramIdHash,
      sessionHash,
      userId: targetUserId,
      merged,
    });

    return { ok: true, userId: targetUserId, merged, alreadyLinked: false } as const;
  });
}

function hash8(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}
