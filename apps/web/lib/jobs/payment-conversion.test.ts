import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Метрика конверсии — единственный сигнал отказа вида «шлюз отвечает 200,
 * ссылку выдаёт, а платежи у клиентов не проходят». Транспортный детектор его
 * не видит; ровно так о неработающем L&P узнали от клиентов, а не от системы.
 */

const h = vi.hoisted(() => ({
  conversion: { invoiced: 0, paid: 0 },
  countMock: vi.fn(),
  env: { PAYMENT_PRIMARY_PROVIDER: 'loveandpay' } as Record<string, unknown>,
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  countInvoiceConversion: h.countMock,
}));

vi.mock('../env.server.ts', () => ({
  serverEnv: new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => h.env[key],
  }),
}));

vi.mock('../alerts/notify-ops.ts', () => ({ notifyOps: vi.fn(async () => {}) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import * as Sentry from '@sentry/nextjs';

import { notifyOps } from '../alerts/notify-ops.ts';
import {
  alertOnZeroPaymentConversion,
  resetConversionAlertDedupForTests,
} from './payment-conversion.ts';

describe('alertOnZeroPaymentConversion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetConversionAlertDedupForTests();
    h.countMock.mockImplementation(async () => h.conversion);
  });

  it('счета есть, оплат ноль → алёрт и DM владельцу', async () => {
    h.conversion = { invoiced: 7, paid: 0 };

    await alertOnZeroPaymentConversion();

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyOps).mock.calls[0]?.[0]).toContain('7');
  });

  it('хотя бы одна оплата — молчим', async () => {
    h.conversion = { invoiced: 7, paid: 1 };

    await alertOnZeroPaymentConversion();

    expect(notifyOps).not.toHaveBeenCalled();
  });

  it('мало счетов — молчим: ночью ноль оплат за час это норма', async () => {
    // Шумный алёрт не читают, и он не сработает, когда действительно нужен.
    h.conversion = { invoiced: 3, paid: 0 };

    await alertOnZeroPaymentConversion();

    expect(notifyOps).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('совсем нет счетов — молчим', async () => {
    h.conversion = { invoiced: 0, paid: 0 };

    await alertOnZeroPaymentConversion();

    expect(notifyOps).not.toHaveBeenCalled();
  });

  it('DM дедуплицируется: cron считает каждые 5 минут, личку не спамим', async () => {
    h.conversion = { invoiced: 9, paid: 0 };

    await alertOnZeroPaymentConversion();
    await alertOnZeroPaymentConversion();
    await alertOnZeroPaymentConversion();

    expect(notifyOps).toHaveBeenCalledTimes(1);
    // Sentry дедупит сам, поэтому алёрт шлём каждый раз.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(3);
  });

  it('окно со сдвигом: свежие счета исключены — им ещё не успели заплатить', async () => {
    h.conversion = { invoiced: 0, paid: 0 };

    await alertOnZeroPaymentConversion();

    expect(h.countMock.mock.calls[0]?.[1]).toMatchObject({
      windowMinutes: 70,
      graceMinutes: 10,
    });
  });

  it('сбой запроса не роняет cron — метрика это мониторинг, а не платёжный путь', async () => {
    h.countMock.mockRejectedValueOnce(new Error('db down'));

    await expect(alertOnZeroPaymentConversion()).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
