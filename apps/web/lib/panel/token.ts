import { createHmac } from 'node:crypto';

import { z } from 'zod';

import { timingSafeEqualStr } from '@/lib/security/timing-safe';

/**
 * Подписанные токены панели: полная сессия и промежуточное состояние между
 * двумя факторами входа.
 *
 * Таблицы сессий нет намеренно (спека §4.1): отзыв доступа работает через
 * `staff.is_active`, который проверяется на КАЖДОМ запросе, поэтому отключённый
 * сотрудник теряет доступ немедленно, а не по истечении cookie. Хранить сессии
 * ради отзыва было бы дублированием того же механизма.
 *
 * ⚠️ Назначение (`purpose`) — часть ПОДПИСАННОГО тела, а не соглашение о том,
 * в какую cookie токен положили. Без этого токен «первый фактор пройден» можно
 * было бы подложить в cookie сессии и войти вообще без TOTP.
 */

/** 12 часов — рабочий день с запасом; ночная смена логинится заново. */
export const PANEL_SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * Промежуточный токен живёт минуты: между «нажал кнопку Telegram» и «ввёл
 * шестизначный код» проходят секунды, а долгий срок означал бы окно, в котором
 * первый фактор ждёт применения.
 */
export const PANEL_PENDING_TTL_SECONDS = 10 * 60;

const TOKEN_VERSION = 'v1';

export type PanelTokenPurpose = 'session' | 'pending';

export type PanelTokenResult =
  | { ok: true; staffId: string; issuedAt: number }
  | {
      ok: false;
      reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_purpose' | 'not_configured';
    };

const bodySchema = z.object({
  /** purpose */
  p: z.enum(['session', 'pending']),
  /** staff id */
  s: z.string().min(1),
  /** issued at, unix-секунды */
  i: z.number().int().positive(),
});

const TTL_BY_PURPOSE: Record<PanelTokenPurpose, number> = {
  session: PANEL_SESSION_TTL_SECONDS,
  pending: PANEL_PENDING_TTL_SECONDS,
};

export function signPanelToken(
  input: { purpose: PanelTokenPurpose; staffId: string },
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is not set; cannot sign panel token');

  const body = Buffer.from(
    JSON.stringify({ p: input.purpose, s: input.staffId, i: nowSeconds }),
    'utf8',
  ).toString('base64url');

  return `${TOKEN_VERSION}.${body}.${signature(body, secret)}`;
}

export function verifyPanelToken(
  token: string,
  secret: string,
  opts: { purpose: PanelTokenPurpose; nowSeconds?: number },
): PanelTokenResult {
  if (!secret) return { ok: false, reason: 'not_configured' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [version, body, provided] = parts as [string, string, string];
  if (version !== TOKEN_VERSION || !body || !provided) return { ok: false, reason: 'malformed' };

  // Сравнение — общим `timingSafeEqualStr` (сверка SHA-256 дайджестов). Прямой
  // `timingSafeEqual` над буферами требовал бы проверки длины в БАЙТАХ, а
  // наивная проверка в символах роняла бы RangeError на cookie с одним
  // многобайтовым символом в подписи — падала бы САМА страница входа, с которой
  // эту cookie уже не сбросить.
  if (!timingSafeEqualStr(signature(body, secret), provided)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  } catch {
    // Подпись сошлась, а тело не разбирается — это наш собственный дрейф
    // формата, а не подделка. Для входящего результат один: отказ.
    return { ok: false, reason: 'malformed' };
  }

  // Назначение сверяем ПОСЛЕ подписи: до неё содержимое ничего не значит.
  if (parsed.p !== opts.purpose) return { ok: false, reason: 'wrong_purpose' };

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const age = now - parsed.i;
  // Отрицательный возраст — часы разъехались либо токен подписан «в будущее».
  // Принимать нельзя: это продление сессии сверх TTL.
  if (age < 0 || age > TTL_BY_PURPOSE[parsed.p]) return { ok: false, reason: 'expired' };

  return { ok: true, staffId: parsed.s, issuedAt: parsed.i };
}

function signature(body: string, secret: string): string {
  return createHmac('sha256', secret).update(`${TOKEN_VERSION}.${body}`).digest('base64url');
}
