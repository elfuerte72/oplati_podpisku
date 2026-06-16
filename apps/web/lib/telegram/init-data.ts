import 'server-only';

import { createHmac } from 'node:crypto';

import { telegramWebAppUser, type TelegramWebAppUser } from '@oplati/types';

import { timingSafeEqualStr } from '../security/timing-safe.ts';

/**
 * Валидация Telegram Mini App `initData` (личный кабинет — Mini App).
 *
 * `initData` — URL-encoded query-string, которую Telegram кладёт в
 * `window.Telegram.WebApp.initData` и подписывает токеном бота. Это
 * ЕДИНСТВЕННАЯ гарантия личности в Mini App: cookie/линк-токены тут не нужны,
 * но и доверять полям без проверки подписи нельзя (клиент может их подделать).
 *
 * Алгоритм (контракт Telegram — https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *   1. распарсить query-string, отделить `hash`;
 *   2. `data_check_string` — все прочие пары `key=value`, отсортированные по
 *      ключу, склеенные через `\n` (значения — декодированные);
 *   3. `secret_key = HMAC_SHA256(key="WebAppData", message=<bot_token>)`;
 *   4. `computed = HMAC_SHA256(key=secret_key, message=data_check_string)` (hex);
 *   5. сравнить `computed` с `hash` (timing-safe);
 *   6. проверить свежесть `auth_date`.
 *
 * ВНИМАНИЕ (правило проекта «не выдумывать контракт»): алгоритм взят из доки,
 * но НЕ подтверждён живым `initData`. Smoke-тест dev-бота (`@dev_test_podpiska_bot`)
 * — обязательный шаг приёмки. Если живая подпись не сойдётся — наиболее вероятная
 * причина в обработке поля `signature` (Ed25519, third-party flow): в каноничном
 * bot-token HMAC исключается только `hash`, но это поведение тоже нужно сверить.
 */

const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60; // 24 часа (решение D1)

export type InitDataFailureReason =
  | 'missing_hash'
  | 'bad_signature'
  | 'expired'
  | 'missing_user'
  | 'malformed';

export type ValidateInitDataResult =
  | { ok: true; user: TelegramWebAppUser; authDate: Date }
  | { ok: false; reason: InitDataFailureReason };

export function validateInitData(
  initData: string,
  botToken: string,
  opts: { maxAgeSeconds?: number; nowMs?: number } = {},
): ValidateInitDataResult {
  const maxAgeSeconds = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;

  const params = new URLSearchParams(initData);

  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'missing_hash' };

  // data_check_string: все пары кроме hash, отсортированные по ключу. Значения
  // берём декодированными (URLSearchParams декодирует сам) — Telegram подписывает
  // именно декодированные значения. `signature` (если есть) оставляем в строке:
  // каноничный алгоритм исключает только `hash` (см. предупреждение в шапке).
  const pairs: string[] = [];
  for (const [key, value] of params) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (!timingSafeEqualStr(computedHash, hash)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Подпись валидна — auth_date'у можно верить. Свежесть: защита от переигровки
  // старого перехваченного initData.
  const authDateRaw = params.get('auth_date');
  const authDateSec = authDateRaw !== null ? Number(authDateRaw) : Number.NaN;
  if (!Number.isFinite(authDateSec) || authDateSec <= 0) {
    return { ok: false, reason: 'malformed' };
  }
  const nowSec = (opts.nowMs ?? Date.now()) / 1000;
  if (nowSec - authDateSec > maxAgeSeconds) {
    return { ok: false, reason: 'expired' };
  }

  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, reason: 'missing_user' };
  let userJson: unknown;
  try {
    userJson = JSON.parse(userRaw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const parsed = telegramWebAppUser.safeParse(userJson);
  if (!parsed.success) {
    return { ok: false, reason: 'malformed' };
  }

  return { ok: true, user: parsed.data, authDate: new Date(authDateSec * 1000) };
}

/** Имя пользователя из Telegram-профиля (для `users.display_name`). */
export function telegramUserDisplayName(user: TelegramWebAppUser): string | null {
  const parts = [user.first_name, user.last_name].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  return parts.length > 0 ? parts.join(' ') : null;
}
