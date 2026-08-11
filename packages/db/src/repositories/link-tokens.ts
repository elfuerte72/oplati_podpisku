import { createHash, randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { shouldInheritReferrerOnMerge } from '@oplati/types';

import type { DB } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Привязка Telegram-аккаунта к веб-сессии через одноразовый deep-link токен.
 *
 * Flow: сайт создаёт токен по `web_session_id` (`createLinkToken`) → пользователь
 * открывает `telegram.me/<bot>?start=link_<token>` → бот получает `/start link_<token>`
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
          // M-2 (находка security): перенести реферальный ledger с удаляемой
          // web-строки на telegram-строку ДО DELETE. beneficiary_user_id и
          // payouts.user_id — FK ON DELETE restrict: без переноса DELETE уронил бы
          // всю транзакцию привязки. referral_partners — cascade: переносим, иначе
          // заработанный тир молча терялся бы (только если у telegram-строки своего
          // профиля ещё нет — PK 1:1; иначе профиль web-строки уйдёт по cascade).
          await tx.execute(
            sql`UPDATE referral_accruals SET beneficiary_user_id = ${byTelegram.id} WHERE beneficiary_user_id = ${byWebSession.id}`,
          );
          // source_user_id НЕ переписываем: иначе строка (beneficiary=W→T, source=W→T)
          // стала бы self-accrual (T заработал с собственной покупки — находка ревью).
          // FK source_user_id = ON DELETE set null → при DELETE W станет NULL («источник
          // неизвестен»), что безопасно и не создаёт самоначисление.

          // ⚠️ Самореферал (аудит 2026-08-10, HIGH). Человек мог открыть СВОЮ ЖЕ
          // реф-ссылку в боте: web-строка W становится реферером telegram-строки
          // T, и покупки T начисляли комиссию W. Гейт `referrerId !== userId` это
          // не ловит — строки разные, человек один. После переноса beneficiary
          // W→T такие строки становятся (beneficiary=T, source=T), то есть
          // «заработал сам с себя».
          //
          // Гасим их по контракту ledger'а: строки append-only, поэтому не
          // удаляем и не правим, а дописываем компенсирующую с status='reversed'
          // и той же суммой (баланс считает accrued − reversed).
          //
          // `created_at` копируется из исходной строки НАМЕРЕННО: месячные
          // агрегаты кабинета считают «начислено за месяц − реверснуто за
          // месяц» по этой колонке, и гашение июльской строки августовским
          // числом рисовало бы партнёру отрицательный доход за август
          // (ревью 2026-08-11).
          //
          // ⚠️ Закрывается ОДИН случай — тот, что нашёл аудит: покупатель и
          // выгодоприобретатель схлопнулись в одного человека при merge.
          // Мультиаккаунт (свою же ссылку открыли с аккаунта A, а web-строку
          // привязали к аккаунту B) отсюда неотличим от честной реферальной
          // пары: для БД это разные люди. Это территория антифрода (Этап E3),
          // см. `docs/BACKLOG.md`.
          const reversedSelf = await tx.execute<{ id: string }>(sql`
            INSERT INTO referral_accruals
              (beneficiary_user_id, source_user_id, order_id, payment_id, level, kind, rate_bps, amount_usd_cents, status, created_at)
            SELECT beneficiary_user_id, source_user_id, order_id, payment_id, level, kind, rate_bps, amount_usd_cents, 'reversed', created_at
            FROM referral_accruals a
            WHERE a.beneficiary_user_id = ${byTelegram.id}
              AND a.source_user_id = ${byTelegram.id}
              AND a.status = 'accrued'
              AND NOT EXISTS (
                SELECT 1 FROM referral_accruals r
                WHERE r.status = 'reversed'
                  AND r.beneficiary_user_id = a.beneficiary_user_id
                  AND r.level = a.level
                  AND r.amount_usd_cents = a.amount_usd_cents
                  AND r.created_at = a.created_at
                  AND r.payment_id IS NOT DISTINCT FROM a.payment_id
              )
            RETURNING id
          `);
          if (reversedSelf.length > 0) {
            // Деньги вернули, а СТАТУС, купленный этим же оборотом, — нет:
            // храповик `locked_rate_l1_bps` только растёт, а с 2026-08-11 он
            // единственный источник платимого процента. Разматывать прогрессию
            // автоматически нельзя (неизвестно, какая доля оборота была
            // самореферальной) — зовём человека.
            log.warn({
              event: 'db.referral.self_accrual_reversed',
              userId: byTelegram.id,
              reversed: reversedSelf.length,
            });
          }

          await tx.execute(
            sql`UPDATE referral_payouts SET user_id = ${byTelegram.id} WHERE user_id = ${byWebSession.id}`,
          );
          // Месячная статистика прогрессии (PK user_id+month, FK ON DELETE cascade):
          // без переноса DELETE молча снёс бы историю партнёра-веб-строки, включая
          // серию consecutive_met_months (срыв серийного бонуса) — находка аудита I1.
          // Конфликтные месяцы (строка есть у обеих) СЛИВАЕМ бережно: серию берём
          // максимумом, plan_met — OR (это НЕ оборот, max серии не двоится); а
          // оборот/новых рефералов оставляем telegram-версии, чтобы не задвоить
          // (находка greptile P2). Порядок: сначала слить конфликтные (обе строки
          // ещё живы), потом перенести неконфликтные, потом DELETE.
          await tx.execute(sql`
            UPDATE referral_monthly_stats t SET
              consecutive_met_months = GREATEST(t.consecutive_met_months, s.consecutive_met_months),
              plan_met = t.plan_met OR s.plan_met
            FROM referral_monthly_stats s
            WHERE t.user_id = ${byTelegram.id} AND s.user_id = ${byWebSession.id}
              AND t.month = s.month
          `);
          await tx.execute(sql`
            UPDATE referral_monthly_stats SET user_id = ${byTelegram.id}
            WHERE user_id = ${byWebSession.id}
              AND NOT EXISTS (
                SELECT 1 FROM referral_monthly_stats t
                WHERE t.user_id = ${byTelegram.id} AND t.month = referral_monthly_stats.month
              )
          `);
          // Профили партнёра есть у ОБЕИХ строк → храповик не должен теряться с
          // web-профилем (cascade-delete): переносим максимум круга/ставки на
          // telegram-профиль; suspended — OR (антифрод-блок переживает merge).
          // Активный буст веб-строки переносим, если он актуальнее telegram-буста
          // (boost_until позже) — иначе партнёр, привязавший аккаунт в середине
          // буст-месяца, терял бы буст до следующего rollup (находка greptile P2).
          await tx.execute(sql`
            UPDATE referral_partners t SET
              current_circle = GREATEST(t.current_circle, s.current_circle),
              locked_rate_l1_bps = GREATEST(t.locked_rate_l1_bps, s.locked_rate_l1_bps),
              suspended = t.suspended OR s.suspended,
              boost_until = CASE
                WHEN s.boost_until IS NOT NULL AND (t.boost_until IS NULL OR s.boost_until > t.boost_until)
                THEN s.boost_until ELSE t.boost_until END,
              boost_rate_bps = CASE
                WHEN s.boost_until IS NOT NULL AND (t.boost_until IS NULL OR s.boost_until > t.boost_until)
                THEN s.boost_rate_bps ELSE t.boost_rate_bps END,
              updated_at = now()
            FROM referral_partners s
            WHERE t.user_id = ${byTelegram.id} AND s.user_id = ${byWebSession.id}
          `);
          await tx.execute(sql`
            UPDATE referral_partners SET user_id = ${byTelegram.id}
            WHERE user_id = ${byWebSession.id}
              AND NOT EXISTS (SELECT 1 FROM referral_partners WHERE user_id = ${byTelegram.id})
          `);

          // Цикл-чек (M-1, находка security): обход вверх по referred_by в tx.
          // Возвращает true, если candidateAncestorId встречается выше ofUserId.
          const isAncestor = async (candidateAncestorId: string, ofUserId: string): Promise<boolean> => {
            let cur = ofUserId;
            const seen = new Set<string>([cur]);
            for (let i = 0; i < 16; i++) {
              const r = await tx.execute<{ referred_by: string | null }>(
                sql`SELECT referred_by FROM users WHERE id = ${cur} LIMIT 1`,
              );
              const parent = r[0]?.referred_by ?? null;
              if (parent === null) return false;
              if (parent === candidateAncestorId) return true;
              if (seen.has(parent)) return false; // существующий цикл — bail
              seen.add(parent);
              cur = parent;
            }
            // Глубина > 16: fail-closed — считаем потенциальным предком, чтобы
            // глубокая цепочка не обошла цикл-чек (находка ревью). Реальные
            // деревья мельче (захват 3 уровня), 16 — с большим запасом.
            return true;
          };

          // Реферальная сеть переживает merge. (1) Реферер удаляемой web-строки
          // наследуется telegram-строкой, если своего нет (referred_by мог появиться
          // при веб-захвате `?ref=` до привязки) — но НЕ если это создаст цикл
          // (telegram-строка уже предок наследуемого реферера). referred_by_set_at
          // = now() — отметка для anti-retro гейта recovery-начислений.
          const sourceReferrer = byWebSession.referred_by;
          if (
            sourceReferrer !== null &&
            shouldInheritReferrerOnMerge(byTelegram.referred_by, sourceReferrer, byTelegram.id) &&
            !(await isAncestor(byTelegram.id, sourceReferrer))
          ) {
            await tx.execute(
              sql`UPDATE users SET referred_by = ${sourceReferrer}, referred_by_set_at = now(), updated_at = now() WHERE id = ${byTelegram.id}`,
            );
          }
          // (2) Рефералы, указывавшие на web-строку, переезжают на telegram-строку —
          // пер-строчно, пропуская тех, для кого это создаст цикл (реферал — предок
          // telegram-строки): такое ребро оставляем на удаляемую строку → DELETE
          // обнулит через onDelete: set null (рвём ребро вместо цикла).
          const children = await tx.execute<{ id: string }>(
            sql`SELECT id FROM users WHERE referred_by = ${byWebSession.id} AND id <> ${byTelegram.id}`,
          );
          for (const child of children) {
            if (await isAncestor(child.id, byTelegram.id)) {
              log.warn({ event: 'db.referral.merge_repoint_cycle_skip', childId: child.id });
              continue;
            }
            await tx.execute(
              sql`UPDATE users SET referred_by = ${byTelegram.id}, updated_at = now() WHERE id = ${child.id}`,
            );
          }

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

/**
 * Чистка протухших неиспользованных токенов (аудит 2026-07-11 F-17: строки
 * копились без retention — сотни за первый месяц). Retention 30 дней ПОСЛЕ
 * истечения: свежепротухшие остаются для расследований (например, диагностика
 * мобильной привязки по `used_at IS NULL`), давно мёртвые — удаляются.
 * Использованные токены (used_at IS NOT NULL) не трогаем — это аудит привязок.
 */
export async function deleteExpiredLinkTokens(
  db: DB,
  opts: { olderThanDays?: number } = {},
  log: RepoLogger = noopLogger,
): Promise<number> {
  const days = opts.olderThanDays ?? 30;
  const deleted = await db.execute<{ id: string }>(sql`
    DELETE FROM link_tokens
    WHERE used_at IS NULL
      AND expires_at < now() - make_interval(days => ${days})
    RETURNING id
  `);
  if (deleted.length > 0) {
    log.info({ event: 'db.link_tokens.cleanup', deleted: deleted.length, olderThanDays: days });
  }
  return deleted.length;
}
