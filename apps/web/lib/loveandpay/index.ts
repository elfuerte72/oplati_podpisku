import 'server-only';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { LoveAndPayClient } from './client.ts';
import { buildProxyFetch, proxyHostForLog } from './proxy-fetch.ts';

/**
 * Lazy-singleton L&P-клиента. На build-time `serverEnv` может быть пуст, поэтому
 * откладываем инициализацию до первого вызова — паттерн совпадает с `getDb()`,
 * `lib/telegram/bot.ts` и т.д.
 */

let _client: LoveAndPayClient | undefined;

export function getLoveAndPayClient(): LoveAndPayClient {
  if (_client) return _client;

  const apiKey = serverEnv.LOVEANDPAY_API_KEY;
  const secretKey = serverEnv.LOVEANDPAY_SECRET_KEY;
  const baseUrl = serverEnv.LOVEANDPAY_BASE_URL;

  if (!apiKey || !secretKey) {
    throw new Error('LOVEANDPAY_API_KEY / LOVEANDPAY_SECRET_KEY не заданы в env');
  }

  const logger = childLogger('loveandpay');

  // L&P allowlist по IP: в проде запросы идут через CONNECT-прокси с фиксированным
  // IP (см. proxy-fetch.ts). URL содержит credentials — в лог только host:port.
  const proxyUrl = serverEnv.LOVEANDPAY_PROXY_URL;
  let fetchImpl: typeof fetch | undefined;
  if (proxyUrl) {
    fetchImpl = buildProxyFetch(proxyUrl);
    logger.info({ event: 'loveandpay.proxy_enabled', proxy: proxyHostForLog(proxyUrl) });
  }

  _client = new LoveAndPayClient({
    apiKey,
    secretKey,
    baseUrl,
    logger,
    fetchImpl,
  });
  return _client;
}

export { LoveAndPayClient } from './client.ts';
export { LoveAndPayApiError, LoveAndPayContractError } from './errors.ts';
export { signRequest, verifyWebhookSignature } from './sign.ts';
