import 'server-only';

import * as Sentry from '@sentry/nextjs';
import {
  rapiraMarketRateSchema,
  rapiraMarketRatesResponseSchema,
  type RapiraMarketRate,
} from '@oplati/types';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';

const RAPIRA_RATES_URL = 'https://api.rapira.net/open/market/rates';
const REQUEST_TIMEOUT_MS = 5_000;
const log = childLogger('rapira.rates');

/**
 * Возвращает цену покупки 1 USDT за RUB по лучшему ask Rapira. На ошибку сети,
 * HTTP или контракта сохраняет управляемую деградацию через env-fallback.
 */
export async function resolveUsdtRubRate(): Promise<number> {
  const fallback = serverEnv.RATE_FALLBACK_USDT_RUB;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(RAPIRA_RATES_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Rapira rates HTTP ${response.status}`);
    }

    const raw: unknown = await response.json();
    const ratesResponse = rapiraMarketRatesResponseSchema.parse(raw);
    if (ratesResponse.code !== 0 || ratesResponse.isWorking !== 1) {
      throw new Error(
        `Rapira rates unavailable: code=${ratesResponse.code}, isWorking=${ratesResponse.isWorking}`,
      );
    }

    let pair: RapiraMarketRate | undefined;
    for (const rawRate of ratesResponse.data) {
      const parsedRate = rapiraMarketRateSchema.safeParse(rawRate);
      if (
        parsedRate.success &&
        parsedRate.data.symbol === 'USDT/RUB' &&
        parsedRate.data.baseCurrency === 'RUB' &&
        parsedRate.data.quoteCurrency === 'USDT'
      ) {
        pair = parsedRate.data;
        break;
      }
    }
    if (!pair) {
      throw new Error('Rapira response has no USDT/RUB pair');
    }

    log.info({ event: 'rapira.rates.usdt_rub.live', rate: pair.askPrice });
    return pair.askPrice;
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    log.warn({ event: 'rapira.rates.usdt_rub.fallback', reason, fallback, err });
    Sentry.captureMessage('USDT/RUB rate fallback used', {
      level: 'warning',
      tags: { source: 'rapira.usdt_rub' },
      extra: { reason, fallback },
    });
    return fallback;
  } finally {
    clearTimeout(timeoutId);
  }
}
