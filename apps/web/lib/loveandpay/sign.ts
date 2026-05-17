import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC v2 подпись Love & Pay.
 *
 * Алгоритм (план MVP, раздел 3.1):
 *   signature = HMAC-SHA256(secretKey, METHOD + PATH + TIMESTAMP_MS + SHA256(body)) → hex
 *
 * Заголовки исходящих:
 *   X-Api-Key: pk_test_* | pk_live_*
 *   X-Timestamp: <ms>
 *   X-Signature: <hex>
 *
 * Webhook (входящие): другой контракт — заголовок `X-Webhook-Signature` содержит
 * HMAC-SHA256(webhookSecret, rawBody) без timestamp. Поэтому verify — отдельная
 * функция с её собственным контрактом.
 */

export type SignedRequest = {
  timestamp: string;
  signature: string;
};

export function signRequest(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: string,
  secretKey: string,
  now: () => number = Date.now,
): SignedRequest {
  const timestamp = String(now());
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const message = `${method}${path}${timestamp}${bodyHash}`;
  const signature = createHmac('sha256', secretKey).update(message).digest('hex');
  return { timestamp, signature };
}

/**
 * Проверка подписи входящего webhook.
 *
 * `rawBody` должен быть точный байт-в-байт string из request.text() — НЕ
 * пересериализованный JSON.parse → JSON.stringify (это меняет порядок ключей и
 * пробелы и инвалидирует подпись). См. webhook handler, который читает
 * `await request.text()` ДО `JSON.parse`.
 *
 * Сравнение — через `timingSafeEqual`, чтобы не утечь длину совпадения через
 * время сравнения (anti-timing-attack).
 */
export function verifyWebhookSignature(
  rawBody: string,
  headerSignature: string | null | undefined,
  webhookSecret: string,
): boolean {
  if (!headerSignature) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(headerSignature, 'utf8');
  // Длины должны совпадать — иначе timingSafeEqual бросит.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
