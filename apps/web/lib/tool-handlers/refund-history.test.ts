import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Учёт возвратов при создании заказа (антифрод-трек, тикет 11): ненулевая
 * история за 180 дней → DM оператору с дедупом; порогов и блокировок НЕТ.
 */

const h = vi.hoisted(() => ({
  count: 0,
  countMock: vi.fn((..._args: unknown[]) => Promise.resolve(h.count)),
  notifyOpsMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  countRefundishHistoryByUser: h.countMock,
  // Остальной propose-order в этом тесте не исполняется.
  countRecentOrdersByUser: vi.fn(),
  createDraftOrder: vi.fn(),
  findActiveByUserId: vi.fn(),
  getServiceById: vi.fn(),
}));
vi.mock('../alerts/notify-ops.ts', () => ({ notifyOps: h.notifyOpsMock }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { notifyRefundHistoryIfAny, resetRefundHistoryDedupForTests } from './propose-order.ts';

beforeEach(() => {
  vi.clearAllMocks();
  resetRefundHistoryDedupForTests();
  h.count = 0;
});

describe('notifyRefundHistoryIfAny (тикет 11)', () => {
  it('чистая история — тишина, заказ никак не затронут', async () => {
    await notifyRefundHistoryIfAny('user-1');
    expect(h.notifyOpsMock).not.toHaveBeenCalled();
  });

  it('ненулевая история → DM со счётчиком; серия заказов не спамит (дедуп)', async () => {
    h.count = 2;

    await notifyRefundHistoryIfAny('user-1');
    await notifyRefundHistoryIfAny('user-1');

    expect(h.notifyOpsMock).toHaveBeenCalledTimes(1);
    const text = String(h.notifyOpsMock.mock.calls[0]?.[0]);
    expect(text).toContain('2');
    expect(text).toContain('180');
    // Информирование, не блокировка.
    expect(text).toContain('Блокировок нет');
  });

  it('сбой счётчика не роняет создание заказа (never-throw)', async () => {
    h.countMock.mockRejectedValueOnce(new Error('db down'));
    await expect(notifyRefundHistoryIfAny('user-1')).resolves.toBeUndefined();
  });
});
