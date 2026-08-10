import * as Sentry from '@sentry/nextjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.RATE_FALLBACK_USDT_RUB = '77';

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
}));

import { resolveUsdtRubRate } from './rates.ts';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SUCCESS_RESPONSE = {
  data: [
    {
      symbol: 'BTC/USDT',
      askPrice: 62_580,
      bidPrice: 62_292.5,
      baseCurrency: 'USDT',
      quoteCurrency: 'BTC',
    },
    {
      symbol: 'USDT/RUB',
      close: 80.11,
      askPrice: 80.12,
      bidPrice: 80.11,
      baseCurrency: 'RUB',
      quoteCurrency: 'USDT',
    },
  ],
  code: 0,
  message: 'SUCCESS',
  totalPage: null,
  totalElement: null,
  isWorking: 1,
};

beforeEach(() => {
  vi.mocked(Sentry.captureMessage).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveUsdtRubRate', () => {
  it('uses the USDT/RUB ask price from Rapira', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, SUCCESS_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveUsdtRubRate()).resolves.toBe(80.12);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.rapira.net/open/market/rates',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('ignores a malformed unrelated market pair', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(200, {
        ...SUCCESS_RESPONSE,
        data: [{ unexpected: 'market drift' }, SUCCESS_RESPONSE.data[1]],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveUsdtRubRate()).resolves.toBe(80.12);
  });

  it('falls back when the Rapira response has no USDT/RUB pair', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(200, { ...SUCCESS_RESPONSE, data: [SUCCESS_RESPONSE.data[0]] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveUsdtRubRate()).resolves.toBe(77);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'USDT/RUB rate fallback used',
      expect.objectContaining({ tags: { source: 'rapira.usdt_rub' } }),
    );
  });

  it('falls back when Rapira returns a non-success HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(503, { message: 'unavailable' })));

    await expect(resolveUsdtRubRate()).resolves.toBe(77);
  });

  /**
   * Границы правдоподобия (аудит 2026-08-10). Курс фиксируется в заказе на 2
   * часа, поэтому сдвиг порядка величины у провайдера (копейки вместо рублей,
   * смена котируемой валюты) молча продавал бы подписки за бесценок или
   * останавливал продажи — и то и другое без единого сигнала.
   */
  describe('санити-границы курса', () => {
    function withRate(rate: number) {
      return response(200, {
        ...SUCCESS_RESPONSE,
        data: [{ ...SUCCESS_RESPONSE.data[1], askPrice: rate }],
      });
    }

    it('РЕГРЕСС: курс приехал в копейках — fallback + алёрт', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(withRate(0.8012)));

      await expect(resolveUsdtRubRate()).resolves.toBe(77);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'USDT/RUB rate fallback used',
        expect.objectContaining({ tags: { source: 'rapira.usdt_rub' } }),
      );
    });

    it('РЕГРЕСС: курс ×100 подрезается по ВЕРХНЕЙ границе, а не откатывается к fallback', async () => {
      // Откат к 81 при завышенном курсе продавал бы подписки ниже
      // себестоимости — деградация обязана быть в нашу сторону.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(withRate(8012)));

      await expect(resolveUsdtRubRate()).resolves.toBe(400);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('подрезан'),
        expect.objectContaining({ level: 'error' }),
      );
    });

    it('реальное движение рынка (120 ₽/$) принимается без алёрта', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(withRate(120.5)));

      await expect(resolveUsdtRubRate()).resolves.toBe(120.5);
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });
  });
});
