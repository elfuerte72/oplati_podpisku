import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { FreekassaNotification } from '@oplati/types';

/**
 * Подписи Freekassa. Их ДВЕ, и они не взаимозаменяемы:
 *
 *  1. Исходящий запрос к API — `HMAC-SHA256` по значениям параметров,
 *     отсортированных ПО КЛЮЧАМ и склеенных через `|`, ключ — **API-ключ**
 *     (раздел 2.2 доки; PHP-эталон:
 *     `ksort($data); hash_hmac('sha256', implode('|', $data), $api_key)`).
 *  2. Входящее уведомление — `MD5("MERCHANT_ID:AMOUNT:секретное слово 2:MERCHANT_ORDER_ID")`
 *     (раздел 1.7). MD5 выбрал провайдер, не мы: криптостойкость подписи здесь
 *     ниже, чем у L&P, поэтому anti-replay держится не на ней, а на атомарном
 *     `claimPaymentSucceeded` (инвариант 2).
 *
 * Секретное слово 1 (подпись SCI-формы) кодом не используется вовсе —
 * интеграция строго через API.
 */

/** Значения параметров запроса: только примитивы, как их сериализует JSON. */
export type FreekassaSignableParams = Record<string, string | number>;

/**
 * Каноническая строка для HMAC: значения в алфавитном порядке КЛЮЧЕЙ через `|`.
 *
 * `signature` в неё не входит — он и добавляется к телу уже после подписи
 * (в PHP-эталоне `$data['signature'] = $sign` идёт после `implode`).
 *
 * Про сортировку: PHP `ksort` со стандартными флагами сравнивает наши ключи
 * (`amount`, `currency`, `email`, `i`, `ip`, `nonce`, `paymentId`, `shopId`)
 * побайтно, и `Array.prototype.sort` по code-unit'ам ASCII даёт тот же порядок.
 *
 * Про числа: `String(2490.5)` и `JSON.stringify(2490.5)` в JS — один и тот же
 * алгоритм, поэтому подписываемая строка гарантированно совпадает с тем, что
 * уходит в теле. Отдельного форматирования сумм здесь быть не должно.
 */
export function buildSignaturePayload(params: FreekassaSignableParams): string {
  return Object.keys(params)
    .sort()
    .map((key) => String(params[key]))
    .join('|');
}

/** HMAC-SHA256 подпись запроса к API (поле `signature` в теле). */
export function signApiRequest(params: FreekassaSignableParams, apiKey: string): string {
  return createHmac('sha256', apiKey).update(buildSignaturePayload(params)).digest('hex');
}

/**
 * Ожидаемая подпись уведомления.
 *
 * `AMOUNT` берётся СЫРОЙ строкой, как прислал провайдер: нормализованное нами
 * значение (`2490.50` → `2490.5`) дало бы другой MD5 и отвергло бы валидное
 * уведомление.
 */
export function expectedNotificationSignature(
  n: Pick<FreekassaNotification, 'MERCHANT_ID' | 'AMOUNT' | 'MERCHANT_ORDER_ID'>,
  secretWord2: string,
): string {
  const message = `${n.MERCHANT_ID}:${n.AMOUNT}:${secretWord2}:${n.MERCHANT_ORDER_ID}`;
  return createHash('md5').update(message).digest('hex');
}

/**
 * Проверка подписи уведомления. Сравнение — `timingSafeEqual` (не утекаем длину
 * совпадения через время), регистр hex не важен.
 */
export function verifyNotificationSignature(
  n: Pick<FreekassaNotification, 'MERCHANT_ID' | 'AMOUNT' | 'MERCHANT_ORDER_ID' | 'SIGN'>,
  secretWord2: string,
): boolean {
  const expected = Buffer.from(expectedNotificationSignature(n, secretWord2), 'utf8');
  const provided = Buffer.from(n.SIGN.trim().toLowerCase(), 'utf8');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
