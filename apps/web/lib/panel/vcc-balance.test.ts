import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  getVccBalance: vi.fn(async () => ({
    balanceUsdCents: 12_000,
    pendingUsdCents: 0,
    currency: 'USD',
  })),
  captureException: vi.fn(),
  threshold: 5000,
}));

vi.mock('@/lib/pay-space', () => ({
  isPaySpaceConfigured: h.isConfigured,
  getPaySpaceClient: () => ({ getVccBalance: h.getVccBalance }),
}));

vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        prop === 'PAYSPACE_MIN_VCC_BALANCE_USD_CENTS' ? h.threshold : undefined,
    },
  ),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: h.captureException,
  captureMessage: vi.fn(),
}));

import { readVccBalanceForPanel } from './vcc-balance';

/**
 * Остаток карточного счёта на видном месте (тикет 05). 14 августа его нехватка
 * уронила оплаченный заказ на 11 680 ₽, а пополнение приходит только T+1 —
 * поэтому ценность в том, чтобы увидеть цифру заранее.
 */
describe('readVccBalanceForPanel', () => {
  beforeEach(() => {
    h.isConfigured.mockReturnValue(true);
    h.getVccBalance.mockImplementation(async () => ({
      balanceUsdCents: 12_000,
      pendingUsdCents: 0,
      currency: 'USD',
    }));
    h.captureException.mockClear();
    h.threshold = 5000;
  });

  it('нормальный баланс отдаётся с порогом и без тревоги', async () => {
    expect(await readVccBalanceForPanel()).toEqual({
      state: 'ok',
      balanceUsdCents: 12_000,
      pendingUsdCents: 0,
      thresholdUsdCents: 5000,
      low: false,
    });
  });

  it('баланс ниже порога помечается', async () => {
    h.getVccBalance.mockImplementation(async () => ({
      balanceUsdCents: 4000,
      pendingUsdCents: 0,
      currency: 'USD',
    }));

    expect(await readVccBalanceForPanel()).toMatchObject({ low: true });
  });

  it('порог берётся из ТОГО ЖЕ места, что и алёрт', async () => {
    h.threshold = 20_000;

    expect(await readVccBalanceForPanel()).toMatchObject({
      thresholdUsdCents: 20_000,
      low: true,
    });
  });

  it('порог 0 — это «алёрт выключен», а не «всё всегда хорошо»', async () => {
    // На проде порог сейчас 0 (решение владельца). Подсвечивать нечего:
    // любое значение формально выше нуля, и «зелёный» ввёл бы в заблуждение.
    h.threshold = 0;
    h.getVccBalance.mockImplementation(async () => ({
      balanceUsdCents: 1,
      pendingUsdCents: 0,
      currency: 'USD',
    }));

    expect(await readVccBalanceForPanel()).toMatchObject({ low: false, thresholdUsdCents: 0 });
  });

  it('недоступный провайдер не роняет страницу', async () => {
    h.getVccBalance.mockImplementation(async () => {
      throw new Error('timeout');
    });

    expect(await readVccBalanceForPanel()).toEqual({ state: 'unavailable' });
    // Молчать нельзя: экран покажет «баланс не получен», а разбираться будем
    // по следу в Sentry.
    expect(h.captureException).toHaveBeenCalled();
  });

  it('PaySpace не настроен — это отдельное состояние, а не сбой', async () => {
    h.isConfigured.mockReturnValue(false);

    expect(await readVccBalanceForPanel()).toEqual({ state: 'not_configured' });
    expect(h.captureException).not.toHaveBeenCalled();
  });
});
