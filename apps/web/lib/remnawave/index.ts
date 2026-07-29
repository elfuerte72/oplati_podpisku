import 'server-only';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';

import { createRemnawaveClient, type RemnawaveClient } from './client.ts';
import { subscriptionExpiry } from './period.ts';

export { RemnawaveApiError, RemnawaveContractError } from './errors.ts';
export { remnawaveUsername, type RemnawaveClient } from './client.ts';
export { addOneMonthUtc, isUnlimitedExpiry, subscriptionExpiry } from './period.ts';

/** Целевой срок подписки из env: 0 месяцев = без ограничения. */
export function targetSubscriptionExpiry(now: Date = new Date()): Date {
  return subscriptionExpiry(now, serverEnv.REMNAWAVE_SUBSCRIPTION_MONTHS);
}

/** Подписки бессрочные? От этого зависит, подтягивать ли срок легаси-юзеров. */
export function isUnlimitedSubscriptionMode(): boolean {
  return serverEnv.REMNAWAVE_SUBSCRIPTION_MONTHS <= 0;
}

/** Гейт фичи: без токена кнопка VPN отвечает «временно недоступно». */
export function isRemnawaveConfigured(): boolean {
  return Boolean(serverEnv.REMNAWAVE_API_TOKEN);
}

let cachedClient: RemnawaveClient | null = null;

/** Клиент из env (singleton). Звать только после isRemnawaveConfigured(). */
export function getRemnawaveClient(): RemnawaveClient {
  if (cachedClient) return cachedClient;
  const token = serverEnv.REMNAWAVE_API_TOKEN;
  if (!token) {
    throw new Error('getRemnawaveClient: REMNAWAVE_API_TOKEN не задан');
  }
  cachedClient = createRemnawaveClient({
    token,
    baseUrl: serverEnv.REMNAWAVE_BASE_URL,
    squadUuid: serverEnv.REMNAWAVE_SQUAD_UUID,
    trafficLimitBytes: serverEnv.REMNAWAVE_TRAFFIC_LIMIT_GB * 1024 ** 3,
    logger: childLogger('remnawave'),
  });
  return cachedClient;
}
