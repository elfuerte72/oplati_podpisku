import { randomInt } from 'node:crypto';

import { sql } from 'drizzle-orm';

import {
  walkReferralAncestors,
  REFERRAL_MAX_LEVEL,
  type ReferralAncestor,
} from '@oplati/types';

import type { DB } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Репозиторий реферальной сети (Этап A).
 *
 * Инварианты:
 *  - `referred_by` ставится ТОЛЬКО при создании пользователя (через INSERT в
 *    users-репозитории) либо разово через `setReferrerOnce` (guard `IS NULL` +
 *    самореферал). Никогда не переписывается — дерево неизменяемо.
 *  - Реферальный код — Crockford-base32 lowercase без неоднозначных символов;
 *    выдаётся лениво (`ensureReferralCode`) при первом запросе ссылки.
 *
 * Чистая логика расчёта/обхода — в @oplati/types (тестируется без БД).
 */

// Crockford base32, lowercase, без неоднозначных i/l/o/u — попадает в
// referralCodeSchema (`[0-9a-z]{6,16}`).
const CODE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const CODE_LENGTH = 8;

/** Сгенерировать кандидат реферального кода (несмещённый RNG). */
export function generateReferralCode(length: number = CODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/** Postgres unique-violation (23505) — гонка по UNIQUE referral_code. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

/**
 * Резолв id владельца реферального кода. `null` — кода нет (захвата не будет).
 * Read-only.
 */
export async function resolveReferralCode(db: DB, code: string): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE referral_code = ${code} LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}

/**
 * Гарантирует наличие реферального кода у пользователя (lazy). Идемпотентно:
 * если код уже есть — возвращает его; иначе генерирует уникальный с retry при
 * коллизии UNIQUE. Возвращает код.
 */
export async function ensureReferralCode(
  db: DB,
  userId: string,
  log: RepoLogger = noopLogger,
): Promise<string> {
  const existing = await db.execute<{ referral_code: string | null }>(
    sql`SELECT referral_code FROM users WHERE id = ${userId} LIMIT 1`,
  );
  if (existing.length === 0) {
    throw new Error(`ensureReferralCode: user ${userId} not found`);
  }
  const current = existing[0]?.referral_code ?? null;
  if (current) return current;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    try {
      const rows = await db.execute<{ referral_code: string }>(sql`
        UPDATE users
        SET referral_code = ${code}, updated_at = now()
        WHERE id = ${userId} AND referral_code IS NULL
        RETURNING referral_code
      `);
      const assigned = rows[0]?.referral_code;
      if (assigned) {
        log.info({ event: 'db.referral.code_assigned', userId });
        return assigned;
      }
      // 0 строк: код проставлен конкурентно между SELECT и UPDATE — перечитать.
      const reSelect = await db.execute<{ referral_code: string | null }>(
        sql`SELECT referral_code FROM users WHERE id = ${userId} LIMIT 1`,
      );
      const concurrent = reSelect[0]?.referral_code ?? null;
      if (concurrent) return concurrent;
      throw new Error(`ensureReferralCode: user ${userId} disappeared`);
    } catch (err) {
      if (isUniqueViolation(err)) {
        log.debug({ event: 'db.referral.code_collision', userId, attempt });
        continue; // редкая коллизия кода — пробуем новый
      }
      throw err;
    }
  }
  throw new Error(`ensureReferralCode: не удалось выдать код для ${userId} за 5 попыток`);
}

export type SetReferrerResult =
  | { set: true }
  | { set: false; reason: 'self_referral' | 'already_set' | 'user_not_found' };

/**
 * Разовая установка реферера (immutable): проставляет `referred_by` только если
 * он ещё NULL и `referrerId !== userId` (запрет самореферала). Основной путь
 * захвата — INSERT в users-репозитории (referred_by сразу при создании); эта
 * функция нужна для отложенной привязки (web-cookie, merge) с теми же гарантиями.
 */
export async function setReferrerOnce(
  db: DB,
  userId: string,
  referrerId: string,
  log: RepoLogger = noopLogger,
): Promise<SetReferrerResult> {
  if (referrerId === userId) {
    log.warn({ event: 'db.referral.self_referral_blocked', userId });
    return { set: false, reason: 'self_referral' };
  }
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE users
    SET referred_by = ${referrerId}, referred_by_set_at = now(), updated_at = now()
    WHERE id = ${userId} AND referred_by IS NULL
    RETURNING id
  `);
  if (rows[0]?.id) {
    log.info({ event: 'db.referral.referrer_set', userId });
    return { set: true };
  }
  // Либо уже установлен (immutable защита), либо пользователя нет.
  const exists = await db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE id = ${userId} LIMIT 1`,
  );
  return exists[0]?.id
    ? { set: false, reason: 'already_set' }
    : { set: false, reason: 'user_not_found' };
}

/**
 * Цепочка предков-партнёров (до `maxLevel`) по дереву `referred_by`. Используется
 * при начислении (Этап B). Делегирует обход чистому `walkReferralAncestors`
 * (@oplati/types, протестирован), резолвя родителя одним SELECT за уровень —
 * в одноуровневой программе (REFERRAL_MAX_LEVEL=1) это один запрос.
 */
export async function getReferralAncestors(
  db: DB,
  userId: string,
  maxLevel: number = REFERRAL_MAX_LEVEL,
): Promise<ReferralAncestor[]> {
  const getParentId = async (id: string): Promise<string | null> => {
    const rows = await db.execute<{ referred_by: string | null }>(
      sql`SELECT referred_by FROM users WHERE id = ${id} LIMIT 1`,
    );
    return rows[0]?.referred_by ?? null;
  };
  return walkReferralAncestors(getParentId, userId, maxLevel);
}
