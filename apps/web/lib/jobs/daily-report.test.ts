import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Джоба дневного отчёта. Что держится:
 *   - отчёт уходит в поток `reports` (тема «Отчёты»), а не в чужую тему;
 *   - цифры дня обязательны: упала выборка — джоба бросает, отчёта-полуправды нет;
 *   - срез «сейчас» best-effort: упавший пункт не срывает отправку;
 *   - несостоявшаяся доставка при настроенной группе видна в Sentry.
 */

const h = vi.hoisted(() => ({
  env: { PANEL_HOST: 'admin.oplatishka.com' } as Record<string, string | undefined>,
  notifyStream: vi.fn(async (..._args: unknown[]) => true),
  isOpsDeliveryConfigured: vi.fn(() => true),
  captureMessage: vi.fn(),
  revenueSummary: vi.fn(),
  countHoldsForPanel: vi.fn(),
}));

vi.mock('../env.server.ts', () => ({ serverEnv: h.env }));
vi.mock('../alerts/streams.ts', () => ({
  notifyStream: h.notifyStream,
  isOpsDeliveryConfigured: h.isOpsDeliveryConfigured,
}));
vi.mock('@sentry/nextjs', () => ({ captureMessage: h.captureMessage, captureException: vi.fn() }));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  VCC_SNAPSHOT_PROVIDER: 'payspace',
  revenueSummary: h.revenueSummary,
  dailyAudience: async () => ({
    telegramVisitors: 3,
    botStarts: 2,
    cabinetOpens: 2,
    webVisitors: 1,
    newTelegramUsers: 1,
    referralJoins: 0,
  }),
  dailyOrderFlow: async () => ({ created: 1, invoiced: 1, expired: 0, cancelled: 0, failed: 0, paymentReview: 0 }),
  dailyPaidOrders: async () => ({
    items: [
      {
        shortId: 'ORD-AAAAA',
        paidAt: new Date('2026-09-14T07:09:00.000Z'),
        status: 'completed',
        amountKopecks: 228_000,
        discountKopecks: 0,
        serviceName: 'ChatGPT',
        tierName: 'Plus',
        customDescription: null,
        telegramUsername: 'client_one',
        displayName: null,
      },
    ],
    total: 1,
  }),
  dailyPromoDiscounts: async () => ({ orders: 0, kopecks: 0 }),
  dailySupport: async () => ({ requests: 0, ratings: 0, ratingAverage: null, lowRatings: 0 }),
  countPendingOrdersForPanel: async () => ({ count: 2, sumKopecks: 400_000 }),
  countHoldsForPanel: h.countHoldsForPanel,
  countUnansweredSupportRequests: async () => 0,
  getVccBalanceSnapshot: async () => null,
}));

import { runDailyReport } from './daily-report.ts';

const INPUT = {
  day: '2026-09-14',
  range: { since: '2026-09-13T21:00:00.000Z', until: '2026-09-14T21:00:00.000Z' },
  partial: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.notifyStream.mockImplementation(async () => true);
  h.isOpsDeliveryConfigured.mockImplementation(() => true);
  h.revenueSummary.mockResolvedValue({
    amountKopecks: 228_000,
    paidOrders: 1,
    averageKopecks: 228_000,
    bonusRedeemedKopecks: 0,
  });
  h.countHoldsForPanel.mockResolvedValue(0);
});

describe('runDailyReport', () => {
  it('шлёт один отчёт в поток reports с оплатившим клиентом', async () => {
    const result = await runDailyReport(INPUT);

    expect(result).toEqual({ day: '2026-09-14', sent: true, paidOrders: 1 });
    expect(h.notifyStream).toHaveBeenCalledTimes(1);
    const [stream, text] = h.notifyStream.mock.calls[0] as [string, string];
    expect(stream).toBe('reports');
    expect(text).toContain('@client_one');
    expect(text).toContain('ORD-AAAAA');
    expect(h.captureMessage).not.toHaveBeenCalled();
  });

  it('упавшая выборка дня — джоба бросает и ничего не отправляет', async () => {
    h.revenueSummary.mockRejectedValue(new Error('db down'));

    await expect(runDailyReport(INPUT)).rejects.toThrow('db down');
    expect(h.notifyStream).not.toHaveBeenCalled();
  });

  it('упавший пункт среза «сейчас» — отчёт уходит с пометкой, а не молчит', async () => {
    h.countHoldsForPanel.mockRejectedValue(new Error('timeout'));

    const result = await runDailyReport(INPUT);

    expect(result.sent).toBe(true);
    const text = h.notifyStream.mock.calls[0]?.[1] as string;
    expect(text).toContain('Проверки платежа: не удалось прочитать');
    expect(text).toContain('Оплаты: 2 на');
  });

  it('группа настроена, а доставка сорвалась — предупреждение в Sentry', async () => {
    h.notifyStream.mockImplementation(async () => false);

    const result = await runDailyReport(INPUT);

    expect(result.sent).toBe(false);
    expect(h.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('доставка не настроена (dev без группы и лички) — без Sentry', async () => {
    h.notifyStream.mockImplementation(async () => false);
    h.isOpsDeliveryConfigured.mockImplementation(() => false);

    await runDailyReport(INPUT);

    expect(h.captureMessage).not.toHaveBeenCalled();
  });
});
