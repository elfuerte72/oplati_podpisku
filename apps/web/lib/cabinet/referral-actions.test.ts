import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PayoutDestinationInput } from '@oplati/types';

const hoisted = vi.hoisted(() => ({
  env: { REFERRAL_ENABLED: true, REFERRAL_MIN_PAYOUT_USD_CENTS: 1000 },
}));
vi.mock('../env.server.ts', () => ({ serverEnv: hoisted.env }));
vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

type Profile = { suspended: boolean } | null;
type CreatedPayout = {
  userId: string;
  amountUsdCents: number;
  method?: string | null;
  feeUsdCents?: number | null;
  destination?: Record<string, unknown> | null;
};

vi.mock('@oplati/db', () => {
  const state: { profile: Profile; balance: number; created: CreatedPayout[] } = {
    profile: null,
    balance: 0,
    created: [],
  };
  return {
    getDb: () => ({}) as unknown,
    getPartnerProfile: vi.fn(async () => state.profile),
    // Атомарный контракт: проверка баланса + вставка внутри. Мок воспроизводит
    // решение по балансу (как реальная транзакция под advisory-локом).
    createReferralPayout: vi.fn(async (_db: unknown, p: CreatedPayout) => {
      if (p.amountUsdCents > state.balance) {
        return { ok: false as const, reason: 'insufficient_balance' as const, balanceUsdCents: state.balance };
      }
      state.created.push(p);
      return { ok: true as const, payoutId: 'payout-1' };
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
  __created: () => CreatedPayout[];
  __reset: () => void;
};
const m = db as unknown as MockedDb;

const req = (
  over: Partial<{
    telegramLinked: boolean;
    amountUsdCents: number;
    destination: PayoutDestinationInput | null;
  }> = {},
) => requestReferralPayout({ userId: 'u1', telegramLinked: true, amountUsdCents: 2000, ...over });

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
    expect(db.createReferralPayout).not.toHaveBeenCalled();
  });

  it('без привязки Telegram → telegram_link_required', async () => {
    expect(await req({ telegramLinked: false })).toEqual({ ok: false, error: 'telegram_link_required' });
    expect(db.createReferralPayout).not.toHaveBeenCalled();
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

  it('валидная заявка без реквизитов → ok, method/fee = null, net = вся сумма', async () => {
    m.__setBalance(5000);
    const r = await req({ amountUsdCents: 2000 });
    expect(r).toEqual({
      ok: true,
      payoutId: 'payout-1',
      amountUsdCents: 2000,
      feeUsdCents: 0,
      netUsdCents: 2000,
    });
    expect(m.__created()).toEqual([
      { userId: 'u1', amountUsdCents: 2000, method: null, feeUsdCents: null, destination: null },
    ]);
  });

  it('ровно минимум проходит (граница ≥)', async () => {
    m.__setBalance(1000);
    const r = await req({ amountUsdCents: 1000 });
    expect(r).toMatchObject({ ok: true });
  });
});

describe('requestReferralPayout — реквизиты и комиссия вывода', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.__reset();
    hoisted.env.REFERRAL_ENABLED = true;
    hoisted.env.REFERRAL_MIN_PAYOUT_USD_CENTS = 1000;
    m.__setBalance(5000);
  });

  it('карта РФ: комиссия 3.5%, PAN замаскирован, CVV не хранится', async () => {
    const destination: PayoutDestinationInput = {
      method: 'card_rub',
      pan: '4242 4242 4242 4242',
      holderName: 'IVAN IVANOV',
    };
    const r = await req({ amountUsdCents: 2000, destination });
    // 3.5% от 2000 = 70 → net 1930
    expect(r).toEqual({
      ok: true,
      payoutId: 'payout-1',
      amountUsdCents: 2000,
      feeUsdCents: 70,
      netUsdCents: 1930,
    });
    const created = m.__created()[0]!;
    expect(created.method).toBe('card_rub');
    expect(created.feeUsdCents).toBe(70);
    // В БД уходит только маска + last4 + ФИО — полного PAN нет.
    expect(created.destination).toEqual({
      method: 'card_rub',
      panMasked: '****4242',
      last4: '4242',
      holderName: 'IVAN IVANOV',
    });
    expect(JSON.stringify(created.destination)).not.toContain('4242424242424242');
  });

  it('крипта USDT: комиссия 1%, адрес и сеть сохраняются', async () => {
    const destination: PayoutDestinationInput = {
      method: 'crypto_usdt',
      address: 'TQ5Rk8m9WcNvY2p3aBcDeFgHiJkLmNoPqR',
      network: 'trc20',
    };
    const r = await req({ amountUsdCents: 2000, destination });
    // 1% от 2000 = 20 → net 1980
    expect(r).toEqual({
      ok: true,
      payoutId: 'payout-1',
      amountUsdCents: 2000,
      feeUsdCents: 20,
      netUsdCents: 1980,
    });
    const created = m.__created()[0]!;
    expect(created.method).toBe('crypto_usdt');
    expect(created.feeUsdCents).toBe(20);
    expect(created.destination).toEqual({
      method: 'crypto_usdt',
      address: 'TQ5Rk8m9WcNvY2p3aBcDeFgHiJkLmNoPqR',
      network: 'trc20',
    });
  });
});
