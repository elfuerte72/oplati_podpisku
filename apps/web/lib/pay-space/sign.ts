import { createHash, createHmac, randomUUID } from 'node:crypto';

/**
 * Подпись исходящих запросов к app.pay.space (HMAC-SHA256, base64).
 *
 * Обязательна для ВСЕХ запросов, если в кабинете задан `request_secret`
 * (мы его задали). Контракт из доки (Python-референс):
 *
 *   message = `${METHOD}\n${PATH}\n${CANONICAL_QUERY}\n${BODY_SHA256}\n${TIMESTAMP}\n${NONCE}`
 *   X-Signature = base64( HMAC-SHA256(request_secret, message) )
 *
 * Где:
 *   - METHOD          — HTTP-метод в верхнем регистре
 *   - PATH            — путь запроса (например `/api/v1/vcc/card/create/`)
 *   - CANONICAL_QUERY — query-параметры, отсортированные по ключу (`a=1&b=2`),
 *                       пустая строка для запросов без query
 *   - BODY_SHA256     — sha256(тело) в hex; для пустого тела — sha256("")
 *   - TIMESTAMP       — Unix-СЕКУНДЫ (X-Timestamp); допуск расхождения ±5 мин
 *   - NONCE           — уникальная строка на каждый запрос (X-Nonce), anti-replay
 *
 * NB: точный канонический вид query доку явно не описывает. Наши query-значения
 * (card_id, request_id) — алфавитно-цифровые, поэтому encode здесь no-op;
 * расхождение всё равно проверяем первым живым вызовом (invalid_signature).
 */

export type PaySpaceSignedHeaders = {
  'X-Timestamp': string;
  'X-Nonce': string;
  'X-Signature': string;
};

export function signPaySpaceRequest(args: {
  method: string;
  path: string;
  canonicalQuery: string;
  body: string;
  requestSecret: string;
  now?: () => number;
  nonce?: () => string;
}): PaySpaceSignedHeaders {
  const timestamp = String(Math.floor((args.now?.() ?? Date.now()) / 1000));
  const nonce = args.nonce?.() ?? randomUUID();
  const bodyHash = createHash('sha256').update(args.body).digest('hex');
  const message = [
    args.method.toUpperCase(),
    args.path,
    args.canonicalQuery,
    bodyHash,
    timestamp,
    nonce,
  ].join('\n');
  const signature = createHmac('sha256', args.requestSecret).update(message).digest('base64');
  return { 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': signature };
}

/** Канонический query: ключи отсортированы, `k=v` через `&`, пусто без параметров. */
export function canonicalQuery(
  params: Record<string, string | number | undefined>,
): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}
