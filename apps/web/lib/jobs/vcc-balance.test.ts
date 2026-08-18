import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Алёрт низкого баланса карточного счёта (тикет 11, требования владельца из
 * `docs/BACKLOG.md`).
 *
 * История: алёрт выключили нулём в пороге, потому что он повторялся; 14 августа
 * риск сработал — заказ на 11 680 ₽ упал, потому что $89.50 «были выше порога
 * $50». Четыре требования — личка, дедуп, ОТНОСИТЕЛЬНЫЙ порог и явное
 * выключение — держатся тестами ниже.
 */

const h = vi.hoisted(() => ({
  configured: true,
  balance: 10_000,
  env: {
    PAYSPACE_MIN_VCC_BALANCE_USD_CENTS: 0,
    PAYSPACE_CARD_BUFFER_PERCENT: 20,
    CARD_ISSUE_FEE_USD_CENTS: 400,
    VCC_BALANCE_ALERT_DISABLED: false,
  } as Record<string, unknown>,
  notifyStaff: vi.fn(async (..._args: unknown[]) => ({ delivered: 1, failed: 0, deduped: false })),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../pay-space/index.ts', () => ({
  isPaySpaceConfigured: () => h.configured,
  getPaySpaceClient: () => ({
    getVccBalance: async () => ({ balanceUsdCents: h.balance, pendingUsdCents: 0, currency: 'USD' }),
  }),
}));

vi.mock('../env.server.ts', () => ({
  serverEnv: new Proxy({}, { get: (_t, prop: string) => h.env[prop] }),
}));

vi.mock('../alerts/notify-staff.ts', () => ({ notifyStaff: h.notifyStaff }));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: h.captureMessage,
  captureException: h.captureException,
}));

import { alertOnLowVccBalance, vccAlertThresholdsUsdCents } from './vcc-balance.ts';

const NOW = new Date('2026-08-18T12:00:00Z');

beforeEach(() => {
  h.configured = true;
  h.balance = 10_000;
  h.env = {
    PAYSPACE_MIN_VCC_BALANCE_USD_CENTS: 0,
    PAYSPACE_CARD_BUFFER_PERCENT: 20,
    CARD_ISSUE_FEE_USD_CENTS: 400,
    VCC_BALANCE_ALERT_DISABLED: false,
  };
  h.notifyStaff.mockClear();
  h.captureMessage.mockClear();
});

describe('vccAlertThresholdsUsdCents', () => {
  it('критический порог считается от ТИПОВОГО заказа, а не плоским числом', () => {
    // $100 заказ + 20% буфера + $4 за выпуск = $124. Ровно та сумма, которой
    // не хватило 14 августа при «пороге» $50.
    expect(vccAlertThresholdsUsdCents().critical).toBe(12_400);
  });

  it('предупреждение — от самого дорогого заказа, который можно оформить', () => {
    // Витринный кап $1200: на него нужно $1444. Держать столько владелец не
    // обязан, поэтому это предупреждение, а не авария.
    expect(vccAlertThresholdsUsdCents().low).toBe(144_400);
  });

  it('явно заданный порог перебивает расчёт — это право владельца', () => {
    h.env.PAYSPACE_MIN_VCC_BALANCE_USD_CENTS = 30_000;

    expect(vccAlertThresholdsUsdCents().critical).toBe(30_000);
  });

  it('нулевой буфер и нулевой fee дают ровно цену заказа', () => {
    h.env.PAYSPACE_CARD_BUFFER_PERCENT = 0;
    h.env.CARD_ISSUE_FEE_USD_CENTS = 0;

    expect(vccAlertThresholdsUsdCents().critical).toBe(10_000);
  });
});

describe('alertOnLowVccBalance', () => {
  it('не хватает на типовой заказ — это АВАРИЯ, пишем в личку', async () => {
    h.balance = 8_950; // ровно остаток 14 августа

    await alertOnLowVccBalance(NOW);

    expect(h.notifyStaff).toHaveBeenCalledTimes(1);
    expect(String(h.notifyStaff.mock.calls[0]?.[0])).toContain('89.50');
    expect(String(h.notifyStaff.mock.calls[0]?.[0])).toContain('Критически');
    // Окно — дефолтный час: авария повторяется, пока её не устранят.
    expect(h.notifyStaff.mock.calls[0]?.[1]).toMatchObject({
      dedupKey: 'vcc_balance_critical',
      dedupWindowMs: undefined,
    });
    expect(h.captureMessage).toHaveBeenCalled();
  });

  it('на типовой хватает, на самый дорогой нет — предупреждение раз в СУТКИ', async () => {
    // Держать полторы тысячи долларов на счёте владелец не обязан. Долбить его
    // об этом ежечасно — способ, которым алёрт умер в прошлый раз.
    h.balance = 50_000;

    await alertOnLowVccBalance(NOW);

    const [text, opts] = h.notifyStaff.mock.calls[0] as unknown as [
      string,
      { dedupKey: string; dedupWindowMs?: number },
    ];
    expect(text).toContain('самый дорогой');
    // ⚠️ Ключ с датой САМ ПО СЕБЕ суток не держит: без явного окна дедуп падает
    // на дефолтный час, и владелец получает два десятка DM в сутки о нормальном
    // длительном состоянии — так этот алёрт и отключили 28 июля.
    expect(opts.dedupKey).toBe('vcc_balance_low:2026-08-18');
    expect(opts.dedupWindowMs).toBe(24 * 60 * 60 * 1000);
  });

  it('денег хватает на всё — молчим', async () => {
    h.balance = 200_000;

    await alertOnLowVccBalance(NOW);

    expect(h.notifyStaff).not.toHaveBeenCalled();
    expect(h.captureMessage).not.toHaveBeenCalled();
  });

  it('выключение — ЯВНЫМ флагом, и тогда молчим даже при нуле на счету', async () => {
    // Ноль в пороге выключением больше не является: он выглядел как
    // «настроено», и именно поэтому риск сработал незамеченным.
    h.env.VCC_BALANCE_ALERT_DISABLED = true;
    h.balance = 0;

    await alertOnLowVccBalance(NOW);

    expect(h.notifyStaff).not.toHaveBeenCalled();
    expect(h.captureMessage).not.toHaveBeenCalled();
  });

  it('ноль в пороге больше НЕ выключает алёрт', async () => {
    h.env.PAYSPACE_MIN_VCC_BALANCE_USD_CENTS = 0;
    h.balance = 100;

    await alertOnLowVccBalance(NOW);

    expect(h.notifyStaff).toHaveBeenCalled();
  });

  it('PaySpace не настроен — проверять нечего', async () => {
    h.configured = false;
    h.balance = 0;

    await alertOnLowVccBalance(NOW);

    expect(h.notifyStaff).not.toHaveBeenCalled();
  });
});
