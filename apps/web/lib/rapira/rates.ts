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
 * Границы правдоподобия курса USDT→RUB (аудит 2026-08-10).
 *
 * Курс — множитель ВСЕХ цен, и `propose_order` фиксирует его в заказе на 2 часа.
 * Значение вне этих границ означает не «рынок так сходил», а поломку на стороне
 * провайдера: сменилась котируемая валюта, цена приехала в копейках, поле стало
 * означать другое.
 *
 * Диапазон нарочно широкий (кратно от текущих ~80 ₽): он ловит ошибку ПОРЯДКА
 * величины, а не рыночное движение, и не должен срабатывать на реальном курсе —
 * иначе fallback станет обычным режимом работы и перестанет замечаться. Рубль
 * доходил до ~120 ₽/$ в 2022-м, так что 400 — это про «×10», а не про кризис.
 */
const MIN_PLAUSIBLE_RATE = 20;
const MAX_PLAUSIBLE_RATE = 400;

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

    if (pair.askPrice > MAX_PLAUSIBLE_RATE) {
      // ⚠️ Направление деградации важнее самого факта отбраковки (находка
      // ревью). Откат к `RATE_FALLBACK_USDT_RUB` (81) при курсе 210 продавал бы
      // подписки за ~40% себестоимости, и так на КАЖДОМ заказе, пока человек не
      // разберёт warning в Sentry. Поэтому сверху не откатываемся, а клампим к
      // верхней границе: недобор ограничен границей, а не значением, которое
      // вообще ни при чём. Снизу (курс приехал в копейках, сменилась котируемая
      // валюта) обычный fallback безопасен — он завышает цену, а не занижает.
      const clamped = Math.max(MAX_PLAUSIBLE_RATE, fallback);
      log.warn({ event: 'rapira.rates.usdt_rub.clamped', rate: pair.askPrice, clamped });
      Sentry.captureMessage('USDT/RUB rate above plausible range — курс подрезан по границе', {
        level: 'error',
        tags: { source: 'rapira.usdt_rub' },
        extra: { rate: pair.askPrice, clamped, max: MAX_PLAUSIBLE_RATE },
      });
      return clamped;
    }

    if (pair.askPrice < MIN_PLAUSIBLE_RATE) {
      throw new Error(
        `Rapira USDT/RUB rate below plausible range: ${pair.askPrice} ` +
          `(минимум ${MIN_PLAUSIBLE_RATE})`,
      );
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
