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
  originalCurrency?: string | null;
  commissionPercent: number | null;
};
type Profile = {
  circle: number;
  lockedRateL1Bps: number;
  boostBps: number;
  suspended: boolean;
};
type Ancestor = { userId: string; level: number };
type InsertCall = { sourceUserId: string; orderId: string; paymentId: string; rows: unknown[] };
type Redemption = { amountUsdCents: number; status: 'reserved' | 'spent' | 'released' } | null;

vi.mock('@oplati/db', () => {
  const state: {
    order: Order | null;
    ancestors: Ancestor[];
    profiles: Record<string, Profile | null>;
    insertCalls: InsertCall[];
    redemption: Redemption;
  } = { order: null, ancestors: [], profiles: {}, insertCalls: [], redemption: null };
  return {
    getDb: () => ({}) as unknown,
    getOrderById: vi.fn(async () => state.order),
    getReferralAncestors: vi.fn(async () => state.ancestors),
    getPartnerProfile: vi.fn(async (_db: unknown, userId: string) => state.profiles[userId] ?? null),
    insertCommissionAccruals: vi.fn(async (_db: unknown, params: InsertCall) => {
      state.insertCalls.push(params);
      return params.rows.length;
    }),
    findRedemptionByOrderId: vi.fn(async () => state.redemption),
    __setOrder(o: Order | null) {
      state.order = o;
    },
    __setRedemption(r: Redemption) {
      state.redemption = r;
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
      state.redemption = null;
    },
  };
});

import * as db from '@oplati/db';
import { accrueReferralForPayment } from './accrue.ts';

type MockedDb = typeof db & {
  __setOrder: (o: Order | null) => void;
  __setAncestors: (a: Ancestor[]) => void;
  __setProfile: (id: string, p: Profile | null) => void;
  __setRedemption: (r: Redemption) => void;
  __insertCalls: () => InsertCall[];
  __reset: () => void;
};
const m = db as unknown as MockedDb;

/**
 * Профиль партнёра. `lockedRateL1Bps` по умолчанию согласован с `circle` —
 * так его и ведёт `planMonthlyProgression` (храповик двигает оба поля разом).
 * Разъезд задаётся явно: с 2026-08-11 главная — ЗАФИКСИРОВАННАЯ ставка
 * (решение владельца), и тест на это есть ниже.
 */
const RATE_BY_CIRCLE = [400, 400, 600, 700];
const profile = (over: Partial<Profile>): Profile => {
  const circle = over.circle ?? 0;
  return {
    circle,
    lockedRateL1Bps: RATE_BY_CIRCLE[circle] ?? 400,
    boostBps: 0,
    suspended: false,
    ...over,
  };
};

describe('accrueReferralForPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.__reset();
    hoisted.env.REFERRAL_ENABLED = true;
    hoisted.env.COMMISSION_PERCENT = 30;
  });

  it('начисляет прямому рефереру (круг 2: 6%), база $20', async () => {
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 30 });
    m.__setAncestors([{ userId: 'l1', level: 1 }]);
    m.__setProfile('l1', profile({ circle: 2 }));

    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });

    const calls = m.__insertCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sourceUserId: 'src', orderId: 'o1', paymentId: 'p1' });
    expect(calls[0]?.rows).toEqual([
      { beneficiaryUserId: 'l1', level: 1, rateBps: 600, amountUsdCents: 120 },
    ]);
    // Глубина обхода — дефолт репозитория (REFERRAL_MAX_LEVEL=1), без явного 3.
    expect(db.getReferralAncestors).toHaveBeenCalledWith(expect.anything(), 'src');
  });

  it('suspended-реферер исключается → начислять некому, вставки нет', async () => {
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 30 });
    m.__setAncestors([{ userId: 'l1', level: 1 }]);
    m.__setProfile('l1', profile({ circle: 2, suspended: true }));

    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });

    expect(m.__insertCalls()).toHaveLength(0);
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

  it('буст +1% из профиля применяется к ставке', async () => {
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 30 });
    m.__setAncestors([{ userId: 'l1', level: 1 }]);
    m.__setProfile('l1', profile({ circle: 2, boostBps: 100 }));

    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });

    expect(m.__insertCalls()[0]?.rows).toEqual([
      { beneficiaryUserId: 'l1', level: 1, rateBps: 700, amountUsdCents: 140 },
    ]);
  });

  it('нет реферера → не вставляет', async () => {
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 30 });
    m.__setAncestors([]);
    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });
    expect(m.__insertCalls()).toHaveLength(0);
  });

  it('не-USD валюта заказа → не начисляет (guard от дрейфа базы)', async () => {
    m.__setOrder({
      id: 'o1',
      userId: 'src',
      originalAmount: 2000,
      originalCurrency: 'EUR',
      commissionPercent: 30,
    });
    m.__setAncestors([{ userId: 'l1', level: 1 }]);
    m.__setProfile('l1', profile({ circle: 2 }));

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
    // commissionPercent 1% → комиссия floor(2000*1/100)=20, а начисление 120 > 20.
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 1 });
    m.__setAncestors([{ userId: 'l1', level: 1 }]);
    m.__setProfile('l1', profile({ circle: 2 }));

    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });

    expect(m.__insertCalls()).toHaveLength(0);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  /**
   * Трек referral-balance-spend: баллы платятся из ТОЙ ЖЕ маржи. Без вычета
   * покупатель гасил бы комиссию баллами, а его реферер получал бы процент из
   * уже потраченной маржи — заказ уходил бы в минус вторым путём.
   */
  it('списанные баллы уменьшают потолок: начисление + списание ≤ комиссия', async () => {
    // База $20, комиссия 30% = 600 ¢. Начисление 4% = 80 ¢.
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 30 });
    m.__setAncestors([{ userId: 'l1', level: 1 }]);
    m.__setProfile('l1', profile({ circle: 0, lockedRateL1Bps: 400 }));
    // Баллами погашено 550 ¢ — остаток комиссии 50 ¢, начисления 80 ¢ не влезают.
    m.__setRedemption({ amountUsdCents: 550, status: 'spent' });

    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });

    expect(m.__insertCalls()).toHaveLength(0);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('вся комиссия погашена баллами → рефереру не начисляется ничего', async () => {
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 30 });
    m.__setAncestors([{ userId: 'l1', level: 1 }]);
    m.__setProfile('l1', profile({ circle: 0, lockedRateL1Bps: 400 }));
    m.__setRedemption({ amountUsdCents: 600, status: 'spent' });

    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });

    expect(m.__insertCalls()).toHaveLength(0);
  });

  it('списание, которое ВЕРНУЛИ, маржу не тратило — начисление идёт как обычно', async () => {
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 30 });
    m.__setAncestors([{ userId: 'l1', level: 1 }]);
    m.__setProfile('l1', profile({ circle: 0, lockedRateL1Bps: 400 }));
    m.__setRedemption({ amountUsdCents: 600, status: 'released' });

    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });

    expect(m.__insertCalls()).toHaveLength(1);
  });

  it('небольшое списание оставляет место начислению', async () => {
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 30 });
    m.__setAncestors([{ userId: 'l1', level: 1 }]);
    m.__setProfile('l1', profile({ circle: 0, lockedRateL1Bps: 400 }));
    m.__setRedemption({ amountUsdCents: 100, status: 'spent' });

    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });

    expect(m.__insertCalls()).toHaveLength(1);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });
});

/**
 * Ставка бралась из ДВУХ источников: начисление считало по текущему статусу
 * (`circle` → таблица), кабинет показывал зафиксированную `locked_rate_l1_bps`.
 * При разъезде партнёр видел одну цифру, а получал другую (аудит 2026-08-10).
 * Решение владельца 2026-08-11: главная — зафиксированная, «процент не падает».
 */
describe('accrueReferralForPayment — один источник ставки', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.__reset();
  });

  it('при разъезде платится ЗАФИКСИРОВАННАЯ ставка, а не ставка статуса', async () => {
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 30 });
    m.__setAncestors([{ userId: 'l1', level: 1 }]);
    // Статус просел до 0 (4%), но партнёру зафиксировано 6% — платим 6%.
    m.__setProfile('l1', profile({ circle: 0, lockedRateL1Bps: 600 }));

    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });

    expect(m.__insertCalls()[0]?.rows).toEqual([
      { beneficiaryUserId: 'l1', level: 1, rateBps: 600, amountUsdCents: 120 },
    ]);
  });

  it('без профиля — базовая ставка первого статуса', async () => {
    m.__setOrder({ id: 'o1', userId: 'src', originalAmount: 2000, commissionPercent: 30 });
    m.__setAncestors([{ userId: 'l1', level: 1 }]);

    await accrueReferralForPayment({ orderId: 'o1', paymentId: 'p1' });

    expect(m.__insertCalls()[0]?.rows).toEqual([
      { beneficiaryUserId: 'l1', level: 1, rateBps: 400, amountUsdCents: 80 },
    ]);
  });
});
