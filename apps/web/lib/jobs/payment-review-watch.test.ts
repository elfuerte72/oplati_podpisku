import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Сторож «на проверке банка» дольше 7 дней (антифрод-трек, тикет 04):
 * DM владельцу с дедупом, БЕЗ автозакрытия — у клиента, возможно, списаны
 * деньги, и закрыть заказ по таймеру значит потерять их след.
 */

const h = vi.hoisted(() => ({
  stale: [] as { id: string; shortId: string; amountRub: number | null }[],
  findStaleMock: vi.fn(),
  // (...args) — иначе тип аргументов пустой кортеж и mock.calls[0][0] не читается.
  notifyOpsMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  findStaleOrdersInPaymentReview: h.findStaleMock,
}));
vi.mock('../alerts/notify-ops.ts', () => ({ notifyOps: h.notifyOpsMock }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import * as Sentry from '@sentry/nextjs';

import {
  alertOnStalePaymentReview,
  resetStaleReviewAlertDedupForTests,
} from './payment-review-watch.ts';

const STALE_ORDER = { id: 'ord-1', shortId: 'ORD-STALE', amountRub: 1_168_000 };

beforeEach(() => {
  vi.clearAllMocks();
  resetStaleReviewAlertDedupForTests();
  h.findStaleMock.mockResolvedValue(h.stale);
});

describe('alertOnStalePaymentReview', () => {
  it('залипший заказ → DM владельцу с номером и суммой, статус НЕ трогается', async () => {
    h.findStaleMock.mockResolvedValue([STALE_ORDER]);

    await alertOnStalePaymentReview();

    expect(h.notifyOpsMock).toHaveBeenCalledTimes(1);
    const text = String(h.notifyOpsMock.mock.calls[0]?.[0]);
    expect(text).toContain('ORD-STALE');
    expect(text).toContain('11680.00');
    // Никакого автозакрытия: модуль не знает про transitionOrder вовсе.
    expect(Sentry.captureMessage).toHaveBeenCalled();
  });

  it('повторные прогоны в течение суток не дублируют DM', async () => {
    h.findStaleMock.mockResolvedValue([STALE_ORDER]);

    await alertOnStalePaymentReview();
    await alertOnStalePaymentReview();

    expect(h.notifyOpsMock).toHaveBeenCalledTimes(1);
  });

  it('пусто → тишина; сбой выборки ловится сам (крон не падает)', async () => {
    h.findStaleMock.mockResolvedValue([]);
    await alertOnStalePaymentReview();
    expect(h.notifyOpsMock).not.toHaveBeenCalled();

    h.findStaleMock.mockRejectedValueOnce(new Error('db down'));
    await expect(alertOnStalePaymentReview()).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
