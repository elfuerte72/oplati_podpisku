import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) — второй фактор входа в админ-панель.
 *
 * Реализация своя, а не библиотека: алгоритм умещается в тридцать строк, а
 * лишняя зависимость в аутентификации — ещё один канал поставки, за которым
 * пришлось бы следить. Корректность держится на официальных тест-векторах
 * RFC 6238 и RFC 4648 (`totp.test.ts`), а не на «сравнили сами с собой».
 *
 * SHA-1 здесь не выбор криптостойкости, а совместимость: Google Authenticator и
 * совместимые приложения по умолчанию считают именно так, а сотрудник заводит
 * код в обычном приложении, а не в нашем.
 *
 * Модуль чистый (никаких `server-only`-зависимостей и env) — он же понадобится
 * скриптам и тестам.
 */

/** Шаг окна. 30 с — то, что подставляют приложения по умолчанию. */
export const TOTP_STEP_SECONDS = 30;

/** Длина кода. Шесть цифр — тот же дефолт приложений. */
const TOTP_DIGITS = 6;

/**
 * Допуск по соседним окнам (±1 = ±30 с). Ноль отвергал бы код, введённый на
 * границе окна или при расхождении часов телефона и сервера; больше единицы —
 * продлевал бы жизнь подсмотренного кода без нужды.
 */
const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) без набивки `=` — так секрет принимают приложения. */
export function encodeBase32(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return out;
}

/**
 * Разбор base32. Пробелы и регистр прощаем (приложения показывают секрет
 * группами по четыре), любой другой символ — ошибка: молча выбросить его
 * значило бы получить ДРУГОЙ ключ и необъяснимый отказ входа.
 */
export function decodeBase32(input: string): Buffer {
  const normalized = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('base32: недопустимый символ');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/** Новый секрет: 20 случайных байт — длина, рекомендованная RFC 4226. */
export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

/** Код для конкретного момента (unix-секунды). Используется и в тестах. */
export function totpCodeAt(secretBase32: string, unixSeconds: number): string {
  const counter = Math.floor(unixSeconds / TOTP_STEP_SECONDS);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', decodeBase32(secretBase32)).update(counterBuf).digest();
  // Dynamic truncation (RFC 4226 §5.3): младшие 4 бита последнего байта дают
  // смещение, откуда берём 31-битное число.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** Разбирается ли секрет как base32 — проверка ДО криптографии. */
export function isValidTotpSecret(secret: string | null | undefined): secret is string {
  if (!secret) return false;
  return /^[A-Za-z2-7\s-]+=*$/.test(secret) && secret.replace(/[\s-=]/g, '').length >= 16;
}

export type TotpVerifyResult =
  | { ok: true; step: number }
  | { ok: false; reason: 'bad_code' | 'bad_secret' };

/**
 * Проверка введённого кода.
 *
 * Возвращает НОМЕР ОКНА, а не просто `true`: вызывающий делает код одноразовым,
 * занимая это окно в БД. Без номера пришлось бы вычислять его второй раз и
 * рисковать разъездом с тем, что реально совпало.
 *
 * `bad_secret` отделён от `bad_code` намеренно: битый секрет в БД — это НАША
 * авария, и она обязана попадать в лог отдельной причиной, а не растворяться в
 * «не тот код». Исключений не бросаем и не глотаем: разбор секрета проверяется
 * заранее.
 *
 * Сравнение timing-safe: код короткий и живёт минуту, но утечка по времени
 * сравнения — ровно тот класс ошибок, который потом никто не ищет.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TotpVerifyResult {
  if (!isValidTotpSecret(secretBase32)) return { ok: false, reason: 'bad_secret' };

  const normalized = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return { ok: false, reason: 'bad_code' };

  for (let drift = -TOTP_WINDOW; drift <= TOTP_WINDOW; drift++) {
    const at = nowSeconds + drift * TOTP_STEP_SECONDS;
    if (timingSafeEqual(Buffer.from(totpCodeAt(secretBase32, at)), Buffer.from(normalized))) {
      return { ok: true, step: Math.floor(at / TOTP_STEP_SECONDS) };
    }
  }
  return { ok: false, reason: 'bad_code' };
}

/**
 * otpauth-URI для QR-кода привязки. Формат — де-факто стандарт Google
 * Authenticator: `otpauth://totp/<issuer>:<account>?secret=…&issuer=…`.
 */
export function buildOtpAuthUri(input: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
