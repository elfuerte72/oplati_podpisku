import { beforeEach, describe, expect, it, vi } from 'vitest';

// Env с переключаемым REFERRAL_ENABLED (vi.hoisted — фабрика mock'а поднимается выше импортов).
const hoisted = vi.hoisted(() => ({
  env: { REFERRAL_ENABLED: true, COMMISSION_PERCENT: 30 },
}));
vi.mock('@/lib/env', () => ({ serverEnv: hoisted.env }));

vi.mock('@/lib/logger', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

type Order = {
  id: string;
  userId: string;
  originalAmount: number | null;
  commissionPercent: number | null;
};
type Profile = {
  circle: number;
  lockedRateL1Bps: number;
  teamMultiplier: boolean;
  boostBps: number;
  suspended: boolean;
};
type Ancestor = { userId: string; level: number };
type InsertCall = { sourceUserId: string; orderId: string; paymentId: string; rows: unknown[] };

vi.mock('@oplati/db', () => {
  const state: {
    order: Order | null;
    ancestors: Ancestor[];
    profiles: Record<string, Profile | null>;
    insertCalls: InsertCall[];
  } = { order: null, ancestors: [], profiles: {}, insertCalls: [] };
  return {
    getDb: () => ({}) as unknown,
    getOrderById: vi.fn(async () => state.order),
    getReferralAncestors: vi.fn(async () => state.ancestors),
    getPartnerProfile: vi.fn(async (_db: unknown, userId: string) => state.profiles[userId] ?? null),
    insertCommissionAccruals: vi.fn(async (_db: unknown, params: InsertCall) => {
      state.insertCalls.push(params);
      return params.rows.length;
    }),
    __setOrder(o: Order | null) {
      state.order = o;
    },
    __setAncestors(a: Ancestor[]) {
      state.ancestors = a;
    },
    __setProfile(id: string, p: Profile | null) {
      state.profiles[id] = p;
    },
    __insertCalls() {
      return state.insertCalls;
    },
    __reset() {
      state.order = null;
      state.ancestors = [];
      state.profiles = {};
      state.insertCalls = [];
    },
  };
});

import * as db from '@oplati/db';
import { accrueReferralForPayment } from './accrue.ts';

type MockedDb = typeof db & {
  __setOrder: (o: Order | null) => void;
  __setAncestors: (a: Ancestor[]) => void;
  __setProfile: (id: string, p: Profile | null) => void;
  __insertCalls: () => InsertCall[];
  __reset: () => void;
};
const m = db as unknown as MockedDb;

const profile = (over: Partial<Profile>): Profile => ({
  circle: 0,
  lockedRateL1Bps: 400,
  teamMultiplier: false,
  boostBps: 0,
  suspended: false,
  ...over,
});

describe('accrueReferralForPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.__reset();
    hoisted.env.REFERRAL_ENABLED = true;
    hoisted.env.COMMISSION_PERCENT = 30;
  });

  it('начисляет цепочке из 3 уровней (круг 2: 6%/2%/1%), база $20', async () => {
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 30 });
    m.__setAncestors([
      { userId: 'l1', level: 1 },
      { userId: 'l2', level: 2 },
      { userId: 'l3', level: 3 },
    ]);
    m.__setProfile('l1', profile({ circle: 2 }));
    m.__setProfile('l2', profile({ circle: 2 }));
    m.__setProfile('l3', profile({ circle: 2 }));

    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });

    const calls = m.__insertCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sourceUserId: 'src', orderId: 'o1', paymentId: 'p1' });
    expect(calls[0]?.rows).toEqual([
      { beneficiaryUserId: 'l1', level: 1, rateBps: 600, amountUsdCents: 120 },
      { beneficiaryUserId: 'l2', level: 2, rateBps: 200, amountUsdCents: 40 },
      { beneficiaryUserId: 'l3', level: 3, rateBps: 100, amountUsdCents: 20 },
    ]);
  });

  it('исключает suspended-партнёра из начисления', async () => {
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 30 });
    m.__setAncestors([
      { userId: 'l1', level: 1 },
      { userId: 'l2', level: 2 },
    ]);
    m.__setProfile('l1', profile({ circle: 2, suspended: true }));
    m.__setProfile('l2', profile({ circle: 2 }));

    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });

    const rows = m.__insertCalls()[0]?.rows ?? [];
    expect(rows).toEqual([{ beneficiaryUserId: 'l2', level: 2, rateBps: 200, amountUsdCents: 40 }]);
  });

  it('без профиля партнёра считает по кругу 0 (Клиент 4%)', async () => {
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 1599, commissionPercent: 30 });
    m.__setAncestors([{ userId: 'l1', level: 1 }]);
    // профиль не задан → null → круг 0

    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });

    // $15.99 × 4% = $0.63 (floor)
    expect(m.__insertCalls()[0]?.rows).toEqual([
      { beneficiaryUserId: 'l1', level: 1, rateBps: 400, amountUsdCents: 63 },
    ]);
  });

  it('нет реферера → не вставляет', async () => {
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 30 });
    m.__setAncestors([]);
    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });
    expect(m.__insertCalls()).toHaveLength(0);
  });

  it('нет USD-базы (originalAmount null) → не вставляет', async () => {
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: null, commissionPercent: 30 });
    m.__setAncestors([{ userId: 'l1', level: 1 }]);
    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });
    expect(m.__insertCalls()).toHaveLength(0);
  });

  it('REFERRAL_ENABLED=false → не трогает БД', async () => {
    hoisted.env.REFERRAL_ENABLED = false;
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 30 });
    m.__setAncestors([{ userId: 'l1', level: 1 }]);
    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });
    expect(db.getOrderById).not.toHaveBeenCalled();
    expect(m.__insertCalls()).toHaveLength(0);
  });

  it('инвариант: начисление > комиссии заказа → не вставляет + Sentry alert', async () => {
    // commissionPercent 1% → комиссия floor(2000*1/100)=20, а начисление цепочки 180 > 20.
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 1 });
    m.__setAncestors([
      { userId: 'l1', level: 1 },
      { userId: 'l2', level: 2 },
      { userId: 'l3', level: 3 },
    ]);
    m.__setProfile('l1', profile({ circle: 2 }));
    m.__setProfile('l2', profile({ circle: 2 }));
    m.__setProfile('l3', profile({ circle: 2 }));

    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });

    expect(m.__insertCalls()).toHaveLength(0);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });
});
