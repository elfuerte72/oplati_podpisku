import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { getLoveAndPayClient, LoveAndPayApiError } from './index.ts';

const log = childLogger('rates');

/**
 * Курс USDT/RUB через L&P `/api/v2/rates`. На любую ошибку (RATE_NOT_FOUND,
 * network, contract drift) — fallback на константу из env
 * `RATE_FALLBACK_USDT_RUB` + Sentry warning, чтобы было видно, сколько
 * заказов прошло на fallback'е.
 *
 * Используется в propose_order (фиксация курса заказа) и в /api/catalog
 * (отображение цен тарифов в рублях).
 */
export async function resolveUsdtRubRate(): Promise<number> {
  const fallback = serverEnv.RATE_FALLBACK_USDT_RUB;
  try {
    const loveAndPay = getLoveAndPayClient();
    const ratesResp = await loveAndPay.getRates('USDT', 'RUB');
    const rate = ratesResp.rate.rate;
    if (!rate || rate <= 0) {
      throw new Error(`L&P вернул некорректный курс: ${rate}`);
    }
    log.info({ event: 'rates.usdt_rub.live', rate });
    return rate;
  } catch (err) {
    const code = err instanceof LoveAndPayApiError ? err.code : 'unknown';
    log.warn({ event: 'rates.usdt_rub.fallback', reason: code, fallback, err });
    Sentry.captureMessage('USDT/RUB rate fallback used', {
      level: 'warning',
      tags: { source: 'rates.usdt_rub' },
      extra: { code, fallback },
    });
    return fallback;
  }
}
