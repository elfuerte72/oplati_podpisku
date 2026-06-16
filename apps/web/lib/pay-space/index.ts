import 'server-only';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { PaySpaceClient } from './client.ts';

let _client: PaySpaceClient | undefined;

/**
 * Сконфигурирован ли PaySpace (есть ли ключ для выпуска карт).
 *
 * Нужен issue-card для graceful-degradation: без ключа заказ остаётся в `paid`
 * (ручной fulfillment оператором), а не падает в `failed`. Проверять ДО
 * `getPaySpaceClient()`, который при отсутствии ключа бросает.
 *
 * accountId провайдеру не передаётся (он неявен в API-ключе), поэтому в guard
 * он больше не участвует.
 */
export function isPaySpaceConfigured(): boolean {
  return Boolean(serverEnv.PAYSPACE_API_KEY);
}

export function getPaySpaceClient(): PaySpaceClient {
  if (_client) return _client;

  const apiKey = serverEnv.PAYSPACE_API_KEY;
  const baseUrl = serverEnv.PAYSPACE_BASE_URL;
  const requestSecret = serverEnv.PAYSPACE_REQUEST_SECRET;

  if (!apiKey) {
    throw new Error('PAYSPACE_API_KEY не задан в env');
  }

  _client = new PaySpaceClient({
    apiKey,
    baseUrl,
    requestSecret,
    logger: childLogger('paypace'),
  });
  return _client;
}

export { PaySpaceClient } from './client.ts';
export { PaySpaceApiError, PaySpaceContractError } from './errors.ts';
