import 'server-only';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { PaySpaceClient } from './client.ts';

let _client: PaySpaceClient | undefined;

/**
 * Сконфигурирован ли PaySpace (есть ли ключи для выпуска карт).
 *
 * Нужен issue-card для graceful-degradation: без ключей заказ остаётся в `paid`
 * (ручной fulfillment оператором), а не падает в `failed`. Проверять ДО
 * `getPaySpaceClient()`, который при отсутствии ключей бросает.
 */
export function isPaySpaceConfigured(): boolean {
  return Boolean(serverEnv.PAYSPACE_API_KEY && serverEnv.PAYSPACE_ACCOUNT_ID);
}

export function getPaySpaceClient(): PaySpaceClient {
  if (_client) return _client;

  const apiKey = serverEnv.PAYSPACE_API_KEY;
  const accountId = serverEnv.PAYSPACE_ACCOUNT_ID;
  const baseUrl = serverEnv.PAYSPACE_BASE_URL;

  if (!apiKey || !accountId) {
    throw new Error('PAYSPACE_API_KEY / PAYSPACE_ACCOUNT_ID не заданы в env');
  }

  _client = new PaySpaceClient({
    apiKey,
    accountId,
    baseUrl,
    logger: childLogger('paypace'),
  });
  return _client;
}

export { PaySpaceClient } from './client.ts';
export { PaySpaceApiError, PaySpaceContractError } from './errors.ts';
