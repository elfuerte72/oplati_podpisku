import 'server-only';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { FkWalletClient } from './client.ts';
import { FkWalletApiError } from './errors.ts';

/**
 * Lazy-синглтон клиента FKWallet — тот же паттерн, что у `getFreekassaClient()`:
 * на build-time `serverEnv` может быть пуст, инициализация откладывается до
 * первого вызова.
 */

let _client: FkWalletClient | undefined;

/** Заданы ли оба ключа. Без них раздел «Финансы» пишет «не настроено». */
export function isFkWalletConfigured(): boolean {
  return Boolean(serverEnv.FKWALLET_PUBLIC_KEY && serverEnv.FKWALLET_PRIVATE_KEY);
}

export function getFkWalletClient(): FkWalletClient {
  if (_client) return _client;

  const publicKey = serverEnv.FKWALLET_PUBLIC_KEY;
  const privateKey = serverEnv.FKWALLET_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    throw new Error('FKWALLET_PUBLIC_KEY / FKWALLET_PRIVATE_KEY не заданы в env');
  }

  _client = new FkWalletClient({
    publicKey,
    privateKey,
    baseUrl: serverEnv.FKWALLET_BASE_URL,
    logger: childLogger('fkwallet'),
  });
  return _client;
}

/**
 * «Кошелёк недоступен» против «кошелёк отказал» — та же граница, что у
 * Freekassa: недоступность это только 5xx/429 самого провайдера; 4xx и дрейф
 * контракта — отказ по существу, «попробуйте позже» его не вылечит.
 */
export function isFkWalletUnavailable(err: unknown): boolean {
  if (err instanceof FkWalletApiError) {
    return err.httpStatus >= 500 || err.httpStatus === 429;
  }
  return false;
}

export { FkWalletClient } from './client.ts';
export { FkWalletApiError, FkWalletContractError } from './errors.ts';
