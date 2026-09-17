import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Форма ответа остатка карточного счёта — как у `readVccBalanceForPanel`. */
type VccReading =
  | {
      state: 'ok' | 'stale';
      balanceUsdCents: number;
      pendingUsdCents: number;
      thresholdUsdCents: number;
      low: boolean;
      readAt: Date;
    }
  | { state: 'unavailable' }
  | { state: 'not_configured' };

const h = vi.hoisted(() => ({
  payspaceConfigured: true,
  freekassaConfigured: true,
  getBalances: vi.fn(async () => ({
    balances: [
      { id: '748', code: 'USDT-TRC20', chain: 'Tron', amount: '3.5985', fiatUsdCents: 360, isActive: true },
      { id: '752', code: 'USDT-BEP20', chain: 'BSC', amount: '10.770519', fiatUsdCents: 1077, isActive: true },
      { id: '754', code: 'BTC', chain: 'Bitcoin', amount: '0', fiatUsdCents: 0, isActive: true },
    ],
    totalUsdCents: 1437,
    fiatCurrency: 'USD',
  })),
  getBalance: vi.fn(async () => [
    { currency: 'RUB', value: '4026.31' },
    { currency: 'USD', value: '0.00' },
  ]),
  listWithdrawals: vi.fn(async () => [
    { id: '3139438', amount: '7300', currency: 'RUB', ext_currency_id: 11, date: '2026-09-15 10:03:27', status: 1 },
    { id: '3077350', amount: '19000', currency: 'RUB', ext_currency_id: 99, date: '2026-08-17 17:02:14', status: 1 },
  ]),
  readVccBalance: vi.fn(
    async (): Promise<VccReading> => ({
      state: 'ok',
      balanceUsdCents: 24_684,
      pendingUsdCents: 5263,
      thresholdUsdCents: 12_400,
      low: false,
      readAt: new Date('2026-09-16T12:00:00Z'),
    }),
  ),
  summarizeFundCommitments: vi.fn(async () => ({
    committedUsdCents: 6000,
    reservedUsdCents: 1200,
    safetyReserveUsdCents: 0,
  })),
  fkwalletConfigured: true,
  fkGetBalance: vi.fn(async () => [
    { currency_code: 'RUB', value: '15000.00' },
    { currency_code: 'USDT', value: '0' },
  ]),
  resolveRate: vi.fn(async () => 81),
  captureException: vi.fn(),
}));

vi.mock('@/lib/env.server', () => ({
  serverEnv: { PAYSPACE_VCC_TOPUP_FEE_PERCENT: 3 },
}));

vi.mock('@/lib/fkwallet', () => ({
  isFkWalletConfigured: () => h.fkwalletConfigured,
  getFkWalletClient: () => ({ getBalance: h.fkGetBalance }),
  isFkWalletUnavailable: (err: unknown) =>
    typeof err === 'object' && err !== null && (err as { httpStatus?: number }).httpStatus === 503,
}));

vi.mock('@/lib/rapira/rates', () => ({
  resolveUsdtRubRate: h.resolveRate,
}));

vi.mock('@oplati/db', () => ({ getDb: () => ({}) }));

vi.mock('@/lib/pay-space', () => ({
  isPaySpaceConfigured: () => h.payspaceConfigured,
  getPaySpaceClient: () => ({ getBalances: h.getBalances }),
}));

vi.mock('@/lib/pay-space/preflight', () => ({
  summarizeFundCommitments: h.summarizeFundCommitments,
}));

vi.mock('@/lib/freekassa', () => ({
  isFreekassaConfigured: () => h.freekassaConfigured,
  getFreekassaClient: () => ({ getBalance: h.getBalance, listWithdrawals: h.listWithdrawals }),
  isFreekassaUnavailable: (err: unknown) =>
    typeof err === 'object' && err !== null && (err as { code?: string }).code === 'QUEUE_TIMEOUT',
}));

vi.mock('./vcc-balance', () => ({
  readVccBalanceForPanel: h.readVccBalance,
  isSlowProviderError: (err: unknown) => err instanceof Error && err.name === 'AbortError',
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: h.captureException,
  captureMessage: vi.fn(),
}));

import { hasFunds, readTreasuryForPanel, resetTreasuryCacheForTests } from './treasury';

const NOW = new Date('2026-09-16T12:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

/**
 * Раздел «Финансы» (трек treasury, тикет 01): три счёта и «свободно» — на
 * одном экране, и ни один сбой провайдера не роняет остальные карточки.
 */
describe('readTreasuryForPanel', () => {
  beforeEach(() => {
    h.payspaceConfigured = true;
    h.freekassaConfigured = true;
    h.fkwalletConfigured = true;
    // mockClear, а не только mockImplementation: `clearMocks` в конфиге выключен,
    // и без сброса истории ассерт по `mock.calls` читал бы вызов соседнего теста.
    for (const fn of [
      h.getBalances,
      h.getBalance,
      h.listWithdrawals,
      h.readVccBalance,
      h.summarizeFundCommitments,
      h.fkGetBalance,
      h.resolveRate,
      h.captureException,
    ]) {
      fn.mockClear();
    }
    h.fkGetBalance.mockImplementation(async () => [
      { currency_code: 'RUB', value: '15000.00' },
      { currency_code: 'USDT', value: '0' },
    ]);
    h.resolveRate.mockImplementation(async () => 81);
    h.getBalances.mockImplementation(async () => ({
      balances: [
        { id: '748', code: 'USDT-TRC20', chain: 'Tron', amount: '3.5985', fiatUsdCents: 360, isActive: true },
        { id: '752', code: 'USDT-BEP20', chain: 'BSC', amount: '10.770519', fiatUsdCents: 1077, isActive: true },
        { id: '754', code: 'BTC', chain: 'Bitcoin', amount: '0', fiatUsdCents: 0, isActive: true },
      ],
      totalUsdCents: 1437,
      fiatCurrency: 'USD',
    }));
    h.getBalance.mockImplementation(async () => [
      { currency: 'RUB', value: '4026.31' },
      { currency: 'USD', value: '0.00' },
    ]);
    h.listWithdrawals.mockImplementation(async () => [
      { id: '3139438', amount: '7300', currency: 'RUB', ext_currency_id: 11, date: '2026-09-15 10:03:27', status: 1 },
      { id: '3077350', amount: '19000', currency: 'RUB', ext_currency_id: 99, date: '2026-08-17 17:02:14', status: 1 },
    ]);
    h.readVccBalance.mockImplementation(async () => ({
      state: 'ok',
      balanceUsdCents: 24_684,
      pendingUsdCents: 5263,
      thresholdUsdCents: 12_400,
      low: false,
      readAt: NOW,
    }));
    h.summarizeFundCommitments.mockImplementation(async () => ({
      committedUsdCents: 6000,
      reservedUsdCents: 1200,
      safetyReserveUsdCents: 0,
    }));
    resetTreasuryCacheForTests();
  });

  it('собирает три счёта и считает «свободно» той же арифметикой, что гейт', async () => {
    const report = await readTreasuryForPanel(NOW);

    // 246.84 − 60.00 обещано − 12.00 занято − 0 запас.
    expect(report.freeUsdCents).toBe(24_684 - 6000 - 1200);
    expect(report.fund).toMatchObject({ state: 'ok', committedUsdCents: 6000, reservedUsdCents: 1200 });

    expect(report.payspace).toMatchObject({
      state: 'ok',
      readAt: NOW,
      data: { totalUsdCents: 1437 },
    });
    if (report.payspace.state !== 'ok') throw new Error('ожидали ok');
    expect(report.payspace.data.balances).toHaveLength(3);

    expect(report.freekassa).toMatchObject({ state: 'ok', readAt: NOW });
    if (report.freekassa.state !== 'ok') throw new Error('ожидали ok');
    // Рубли — в копейках (инвариант 3), прочие валюты сырой строкой.
    expect(report.freekassa.data.balances).toEqual([
      { currency: 'RUB', raw: '4026.31', amountKopecks: 402_631 },
      { currency: 'USD', raw: '0.00', amountKopecks: null },
    ]);
    // Способ по справочнику провайдера; код вне справочника — `null`, не догадка.
    expect(report.freekassa.data.withdrawals).toEqual([
      expect.objectContaining({ id: '3139438', amountKopecks: 730_000, methodId: 11, methodName: 'FKWallet.io RUB', status: 1 }),
      expect.objectContaining({ id: '3077350', amountKopecks: 1_900_000, methodId: 99, methodName: null }),
    ]);
  });

  it('читает провайдеров коротким поводком, одним заходом и своим ожиданием очереди', async () => {
    await readTreasuryForPanel(NOW);

    expect(h.getBalances).toHaveBeenCalledWith({ timeoutMs: 3000, attempts: 1 });
    expect(h.getBalance).toHaveBeenCalledWith({ timeoutMs: 3000, queueWaitMs: 5000 });
    expect(h.listWithdrawals).toHaveBeenCalledWith({ timeoutMs: 3000, queueWaitMs: 5000 });
    expect(h.fkGetBalance).toHaveBeenCalledWith({ timeoutMs: 3000 });
  });

  it('кошелёк FKWallet: рубли в копейках, USDT сырой строкой', async () => {
    const report = await readTreasuryForPanel(NOW);

    expect(report.fkwallet).toMatchObject({ state: 'ok', readAt: NOW });
    if (report.fkwallet.state !== 'ok') throw new Error('ожидали ok');
    expect(report.fkwallet.data.balances).toEqual([
      { currency: 'RUB', raw: '15000.00', amountKopecks: 1_500_000 },
      { currency: 'USDT', raw: '0', amountKopecks: null },
    ]);
  });

  it('FKWallet не настроен — «не настроено», к нему не ходят, остальное живо', async () => {
    h.fkwalletConfigured = false;

    const report = await readTreasuryForPanel(NOW);

    expect(report.fkwallet).toEqual({ state: 'not_configured' });
    expect(h.fkGetBalance).not.toHaveBeenCalled();
    expect(report.freekassa.state).toBe('ok');
  });

  it('лежащий FKWallet (503) после удачного чтения — прежнее число с пометкой, без Sentry', async () => {
    await readTreasuryForPanel(NOW);
    h.fkGetBalance.mockRejectedValueOnce(Object.assign(new Error('down'), { httpStatus: 503 }));

    const report = await readTreasuryForPanel(later(5 * 60_000));

    expect(report.fkwallet).toMatchObject({ state: 'stale', readAt: NOW });
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('план пополнения: свободного ниже нормы — зачислить до $900, отправить с комиссией, рубли по курсу', async () => {
    const report = await readTreasuryForPanel(NOW);

    // Свободно 246.84 − 60 − 12 = $174.84 → зачислить $725.16; при 3 %
    // отправить 72516·100/97 = 74758.76 → 74759 центов; по 81 ₽ — 60554.79 → 60555 ₽.
    expect(report.topUp).toEqual({
      state: 'refill',
      freeUsdCents: 17_484,
      targetUsdCents: 90_000,
      creditUsdCents: 72_516,
      sendUsdCents: 74_759,
      feePercent: 3,
      rubKopecks: 6_055_500,
      usdtRubRate: 81,
    });
    expect(h.resolveRate).toHaveBeenCalledTimes(1);

    // Курс держится минуту вместе с остатками.
    await readTreasuryForPanel(later(30_000));
    expect(h.resolveRate).toHaveBeenCalledTimes(1);
  });

  it('свободного хватает — «пополнять не нужно», и к Rapira не ходим', async () => {
    h.readVccBalance.mockResolvedValueOnce({
      state: 'ok',
      balanceUsdCents: 100_000,
      pendingUsdCents: 0,
      thresholdUsdCents: 12_400,
      low: false,
      readAt: NOW,
    });

    const report = await readTreasuryForPanel(NOW);

    expect(report.topUp).toEqual({
      state: 'enough',
      freeUsdCents: 100_000 - 7200,
      refillBelowUsdCents: 40_000,
    });
    expect(h.resolveRate).not.toHaveBeenCalled();
  });

  it('свободное неизвестно — плана нет', async () => {
    h.summarizeFundCommitments.mockRejectedValueOnce(new Error('connection refused'));

    const report = await readTreasuryForPanel(NOW);

    expect(report.freeUsdCents).toBeNull();
    expect(report.topUp).toBeNull();
    expect(h.resolveRate).not.toHaveBeenCalled();
  });

  it('держит прочитанное минуту: второй рендер провайдеров не дёргает', async () => {
    await readTreasuryForPanel(NOW);
    await readTreasuryForPanel(later(30_000));

    expect(h.getBalances).toHaveBeenCalledTimes(1);
    expect(h.getBalance).toHaveBeenCalledTimes(1);
    expect(h.listWithdrawals).toHaveBeenCalledTimes(1);

    await readTreasuryForPanel(later(61_000));
    expect(h.getBalances).toHaveBeenCalledTimes(2);
    expect(h.getBalance).toHaveBeenCalledTimes(2);
  });

  it('медленный провайдер после удачного чтения — прежнее число с пометкой, без Sentry', async () => {
    await readTreasuryForPanel(NOW);
    h.getBalances.mockRejectedValueOnce(abortError());
    h.getBalance.mockRejectedValueOnce(Object.assign(new Error('очередь'), { code: 'QUEUE_TIMEOUT' }));

    const report = await readTreasuryForPanel(later(5 * 60_000));

    expect(report.payspace).toMatchObject({ state: 'stale', readAt: NOW, data: { totalUsdCents: 1437 } });
    expect(report.freekassa).toMatchObject({ state: 'stale', readAt: NOW });
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('старше получаса прежнее число не показывается', async () => {
    await readTreasuryForPanel(NOW);
    h.getBalances.mockRejectedValueOnce(abortError());

    const report = await readTreasuryForPanel(later(31 * 60_000));

    expect(report.payspace).toEqual({ state: 'unavailable' });
  });

  it('отказ по существу уходит в Sentry, а карточка — «данные не получены»', async () => {
    h.getBalance.mockRejectedValueOnce(new Error('Response schema mismatch'));

    const report = await readTreasuryForPanel(NOW);

    expect(report.freekassa).toEqual({ state: 'unavailable' });
    expect(h.captureException).toHaveBeenCalledTimes(1);
    // Соседняя карточка жива: отказ одного провайдера не прячет цифры другого.
    expect(report.payspace.state).toBe('ok');
  });

  it('оценка не в долларах — дрейф контракта, а не «просто число»', async () => {
    h.getBalances.mockResolvedValueOnce({ balances: [], totalUsdCents: 100, fiatCurrency: 'EUR' });

    const report = await readTreasuryForPanel(NOW);

    expect(report.payspace).toEqual({ state: 'unavailable' });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('ненастроенный провайдер — «не настроено», и к нему не ходят', async () => {
    h.freekassaConfigured = false;
    h.payspaceConfigured = false;

    const report = await readTreasuryForPanel(NOW);

    expect(report.freekassa).toEqual({ state: 'not_configured' });
    expect(report.payspace).toEqual({ state: 'not_configured' });
    expect(h.getBalance).not.toHaveBeenCalled();
    expect(h.getBalances).not.toHaveBeenCalled();
  });

  it('упавшая база — обязательства не посчитаны, «свободно» неизвестно, остаток цел', async () => {
    h.summarizeFundCommitments.mockRejectedValueOnce(new Error('connection refused'));

    const report = await readTreasuryForPanel(NOW);

    expect(report.fund).toEqual({ state: 'unavailable' });
    expect(report.freeUsdCents).toBeNull();
    expect(report.vcc.state).toBe('ok');
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('обещано больше остатка — «свободно» отрицательное, дыра не прячется', async () => {
    h.summarizeFundCommitments.mockResolvedValueOnce({
      committedUsdCents: 30_000,
      reservedUsdCents: 0,
      safetyReserveUsdCents: 500,
    });

    const report = await readTreasuryForPanel(NOW);

    expect(report.freeUsdCents).toBe(24_684 - 30_000 - 500);
  });

  it('непрочитанный остаток карточного счёта — «свободно» неизвестно', async () => {
    h.readVccBalance.mockResolvedValueOnce({ state: 'unavailable' });

    const report = await readTreasuryForPanel(NOW);

    expect(report.freeUsdCents).toBeNull();
    expect(report.fund.state).toBe('ok');
  });
});

describe('hasFunds', () => {
  it('пустой кошелёк прячется, кошелёк с пылью — нет', () => {
    expect(hasFunds({ amount: '0', fiatUsdCents: 0 })).toBe(false);
    expect(hasFunds({ amount: '0.00000001', fiatUsdCents: 0 })).toBe(true);
    expect(hasFunds({ amount: '0', fiatUsdCents: 1 })).toBe(true);
  });
});
