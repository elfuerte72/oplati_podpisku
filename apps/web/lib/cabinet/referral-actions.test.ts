import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  env: { REFERRAL_ENABLED: true, REFERRAL_MIN_PAYOUT_USD_CENTS: 1000 },
}));
vi.mock('../env.server.ts', () => ({ serverEnv: hoisted.env }));
vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

type Profile = { suspended: boolean } | null;

vi.mock('@oplati/db', () => {
  const state: { profile: Profile; balance: number; created: Array<{ userId: string; amountUsdCents: number }> } = {
    profile: null,
    balance: 0,
    created: [],
  };
  return {
    getDb: () => ({}) as unknown,
    getPartnerProfile: vi.fn(async () => state.profile),
    getReferralBalanceUsdCents: vi.fn(async () => state.balance),
    createReferralPayout: vi.fn(async (_db: unknown, p: { userId: string; amountUsdCents: number }) => {
      state.created.push(p);
      return 'payout-1';
    }),
    __setProfile(p: Profile) {
      state.profile = p;
    },
    __setBalance(b: number) {
      state.balance = b;
    },
    __created() {
      return state.created;
    },
    __reset() {
      state.profile = null;
      state.balance = 0;
      state.created = [];
    },
  };
});

import * as db from '@oplati/db';
import { requestReferralPayout } from './referral-actions.ts';

type MockedDb = typeof db & {
  __setProfile: (p: Profile) => void;
  __setBalance: (b: number) => void;
  __created: () => Array<{ userId: string; amountUsdCents: number }>;
  __reset: () => void;
};
const m = db as unknown as MockedDb;

const req = (over: Partial<{ telegramLinked: boolean; amountUsdCents: number }> = {}) =>
  requestReferralPayout({ userId: 'u1', telegramLinked: true, amountUsdCents: 2000, ...over });

describe('requestReferralPayout — гейты и валидация', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.__reset();
    hoisted.env.REFERRAL_ENABLED = true;
    hoisted.env.REFERRAL_MIN_PAYOUT_USD_CENTS = 1000;
    m.__setBalance(5000);
  });

  it('программа выключена → disabled (БД не трогаем)', async () => {
    hoisted.env.REFERRAL_ENABLED = false;
    expect(await req()).toEqual({ ok: false, error: 'disabled' });
    expect(db.getReferralBalanceUsdCents).not.toHaveBeenCalled();
  });

  it('без привязки Telegram → telegram_link_required', async () => {
    expect(await req({ telegramLinked: false })).toEqual({ ok: false, error: 'telegram_link_required' });
    expect(db.getReferralBalanceUsdCents).not.toHaveBeenCalled();
  });

  it('нецелая/неположительная сумма → invalid_amount', async () => {
    expect(await req({ amountUsdCents: 0 })).toEqual({ ok: false, error: 'invalid_amount' });
    expect(await req({ amountUsdCents: -100 })).toEqual({ ok: false, error: 'invalid_amount' });
    expect(await req({ amountUsdCents: 10.5 })).toEqual({ ok: false, error: 'invalid_amount' });
  });

  it('сумма ниже минимума → below_minimum с порогом', async () => {
    const r = await req({ amountUsdCents: 500 });
    expect(r).toEqual({ ok: false, error: 'below_minimum', minPayoutUsdCents: 1000 });
  });

  it('заблокированный антифродом → suspended', async () => {
    m.__setProfile({ suspended: true });
    expect(await req({ amountUsdCents: 2000 })).toEqual({ ok: false, error: 'suspended' });
    expect(m.__created()).toHaveLength(0);
  });

  it('сумма больше баланса → insufficient_balance с балансом', async () => {
    m.__setBalance(1500);
    const r = await req({ amountUsdCents: 2000 });
    expect(r).toEqual({ ok: false, error: 'insufficient_balance', balanceUsdCents: 1500 });
    expect(m.__created()).toHaveLength(0);
  });

  it('валидная заявка → ok + запись в referral_payouts', async () => {
    m.__setBalance(5000);
    const r = await req({ amountUsdCents: 2000 });
    expect(r).toEqual({ ok: true, payoutId: 'payout-1', amountUsdCents: 2000 });
    expect(m.__created()).toEqual([{ userId: 'u1', amountUsdCents: 2000 }]);
  });

  it('ровно минимум проходит (граница ≥)', async () => {
    m.__setBalance(1000);
    const r = await req({ amountUsdCents: 1000 });
    expect(r).toMatchObject({ ok: true });
  });
});
