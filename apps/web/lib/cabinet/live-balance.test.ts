import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const pay = vi.hoisted(() => ({ configured: true, getCardInfo: vi.fn() }));
vi.mock('../pay-space/index.ts', () => ({
  isPaySpaceConfigured: () => pay.configured,
  getPaySpaceClient: () => ({ getCardInfo: pay.getCardInfo }),
}));

const repo = vi.hoisted(() => ({ syncCardBalance: vi.fn(async () => true) }));
vi.mock('@oplati/db', () => ({
  syncCardBalance: repo.syncCardBalance,
}));

import type { Card } from '@oplati/db';
import { pickPrimaryCard, withLiveBalance } from './live-balance.ts';

const db = {} as Parameters<typeof withLiveBalance>[0];

let seq = 0;
function mkCard(overrides: Partial<Card> = {}): Card {
  seq += 1;
  return {
    id: `card-${seq}`,
    userId: 'u1',
    provider: 'paypace',
    providerCardId: `pc-${seq}`,
    panMasked: '400000******0001',
    status: 'active',
    balanceUsdCents: 2400,
    lastUsedAt: null,
    recycledAt: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pay.configured = true;
  pay.getCardInfo.mockResolvedValue({ balanceUsdCents: 315, cardType: 'VISA' });
});

describe('pickPrimaryCard', () => {
  it('active приоритетнее более свежей idle (совпадает с primaryCard в CabinetClient)', () => {
    const active = mkCard({ status: 'active', createdAt: new Date('2026-06-01T00:00:00Z') });
    const freshIdle = mkCard({ status: 'idle', createdAt: new Date('2026-07-10T00:00:00Z') });
    expect(pickPrimaryCard([freshIdle, active])?.id).toBe(active.id);
  });

  it('без active — самая свежая; пустой список — null', () => {
    const older = mkCard({ status: 'idle', createdAt: new Date('2026-06-01T00:00:00Z') });
    const newer = mkCard({ status: 'idle', createdAt: new Date('2026-07-10T00:00:00Z') });
    expect(pickPrimaryCard([older, newer])?.id).toBe(newer.id);
    expect(pickPrimaryCard([])).toBeNull();
  });
});

describe('withLiveBalance', () => {
  it('live-баланс отличается → обновлённый список + CAS-кэш в БД (по id основной карты)', async () => {
    const card = mkCard({ balanceUsdCents: 2400 });
    const result = await withLiveBalance(db, [card]);
    expect(result[0]?.balanceUsdCents).toBe(315);
    expect(pay.getCardInfo).toHaveBeenCalledWith(card.providerCardId);
    // CAS: ожидание — прочитанный БД-баланс (2400), новое значение — live (315).
    expect(repo.syncCardBalance).toHaveBeenCalledWith(db, card.id, 315, 2400, expect.anything());
  });

  it('CAS проигран (параллельный topup) → отдаём БД-снимок без изменений', async () => {
    repo.syncCardBalance.mockResolvedValueOnce(false);
    const card = mkCard({ balanceUsdCents: 2400 });
    const result = await withLiveBalance(db, [card]);
    expect(result[0]?.balanceUsdCents).toBe(2400);
  });

  it('live совпадает с БД → без записи в БД', async () => {
    const card = mkCard({ balanceUsdCents: 315 });
    const result = await withLiveBalance(db, [card]);
    expect(result).toEqual([card]);
    expect(repo.syncCardBalance).not.toHaveBeenCalled();
  });

  it('обновляется только основная карта, остальные не трогаются', async () => {
    const active = mkCard({ status: 'active', balanceUsdCents: 2400 });
    const idle = mkCard({ status: 'idle', balanceUsdCents: 500 });
    const result = await withLiveBalance(db, [idle, active]);
    expect(result.find((c) => c.id === active.id)?.balanceUsdCents).toBe(315);
    expect(result.find((c) => c.id === idle.id)?.balanceUsdCents).toBe(500);
    expect(pay.getCardInfo).toHaveBeenCalledTimes(1);
  });

  it('сбой PaySpace → исходный БД-снимок, кабинет не падает', async () => {
    pay.getCardInfo.mockRejectedValue(new Error('boom'));
    const card = mkCard({ balanceUsdCents: 2400 });
    const result = await withLiveBalance(db, [card]);
    expect(result[0]?.balanceUsdCents).toBe(2400);
    expect(repo.syncCardBalance).not.toHaveBeenCalled();
  });

  it('превышение бюджета времени → исходный БД-снимок (запрос не ждём)', async () => {
    vi.useFakeTimers();
    try {
      pay.getCardInfo.mockImplementation(
        () => new Promise(() => {}), // «зависший» запрос — никогда не резолвится
      );
      const card = mkCard({ balanceUsdCents: 2400 });
      const pending = withLiveBalance(db, [card]);
      await vi.advanceTimersByTimeAsync(4_100);
      const result = await pending;
      expect(result[0]?.balanceUsdCents).toBe(2400);
      expect(repo.syncCardBalance).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('PaySpace не настроен или карт нет → PaySpace не дёргаем', async () => {
    pay.configured = false;
    const card = mkCard();
    expect(await withLiveBalance(db, [card])).toEqual([card]);
    pay.configured = true;
    expect(await withLiveBalance(db, [])).toEqual([]);
    expect(pay.getCardInfo).not.toHaveBeenCalled();
  });
});
