import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

type Profile = {
  circle: number;
  lockedRateL1Bps: number;
  teamMultiplier: boolean;
  boostBps: number;
  suspended: boolean;
} | null;

type LedgerRow = {
  kind: string;
  level: number;
  amountUsdCents: number;
  status: string;
  createdAt: Date;
  sourceName: string | null;
  serviceName: string | null;
  customDescription: string | null;
};

vi.mock('@oplati/db', () => {
  const state = {
    code: 'abc123' as string | null,
    profile: null as Profile,
    balance: 0,
    network: [] as Array<{ level: number; total: number; active: number; turnoverThisMonthUsdCents: number }>,
    income: [] as Array<{ level: number; allTimeUsdCents: number; thisMonthUsdCents: number }>,
    earnings: { totalUsdCents: 0, thisMonthUsdCents: 0 },
    monthly: [] as Array<{ month: string; usdCents: number }>,
    newRefs: { total: 0, active: 0 },
    ledger: [] as LedgerRow[],
    payouts: [] as Array<{ id: string; amountUsdCents: number; status: string; requestedAt: Date; settledAt: Date | null }>,
    ensureCalls: 0,
  };
  return {
    getDb: () => ({}) as unknown,
    ensureReferralCode: vi.fn(async () => {
      state.ensureCalls++;
      if (state.code === null) throw new Error('boom');
      return state.code;
    }),
    getPartnerProfile: vi.fn(async () => state.profile),
    getReferralBalanceUsdCents: vi.fn(async () => state.balance),
    getReferralNetwork: vi.fn(async () => state.network),
    getReferralIncomeByLevel: vi.fn(async () => state.income),
    getReferralEarnings: vi.fn(async () => state.earnings),
    getReferralMonthlyIncome: vi.fn(async () => state.monthly),
    getNewReferralsThisMonth: vi.fn(async () => state.newRefs),
    getReferralLedger: vi.fn(async () => state.ledger),
    getReferralPayouts: vi.fn(async () => state.payouts),
    __state: state,
  };
});

import * as db from '@oplati/db';
import { buildReferralSnapshot, type ReferralSnapshotContext } from './referral-read.ts';

const state = (db as unknown as { __state: Record<string, unknown> }).__state as {
  code: string | null;
  profile: Profile;
  balance: number;
  network: Array<{ level: number; total: number; active: number; turnoverThisMonthUsdCents: number }>;
  income: Array<{ level: number; allTimeUsdCents: number; thisMonthUsdCents: number }>;
  earnings: { totalUsdCents: number; thisMonthUsdCents: number };
  monthly: Array<{ month: string; usdCents: number }>;
  newRefs: { total: number; active: number };
  ledger: LedgerRow[];
  payouts: Array<{ id: string; amountUsdCents: number; status: string; requestedAt: Date; settledAt: Date | null }>;
  ensureCalls: number;
};

const ctx = (over: Partial<ReferralSnapshotContext> = {}): ReferralSnapshotContext => ({
  enabled: true,
  telegramLinked: true,
  baseUrl: 'https://x.test',
  botUsername: 'mybot',
  minPayoutUsdCents: 1000,
  ...over,
});

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.code = 'abc123';
  state.profile = null;
  state.balance = 0;
  state.network = [];
  state.income = [];
  state.earnings = { totalUsdCents: 0, thisMonthUsdCents: 0 };
  state.monthly = [];
  state.newRefs = { total: 0, active: 0 };
  state.ledger = [];
  state.payouts = [];
  state.ensureCalls = 0;
});

describe('buildReferralSnapshot — выключенная программа', () => {
  it('enabled:false → спящий снапшот, БД и выдача кода не трогаются', async () => {
    const snap = await buildReferralSnapshot('u1', ctx({ enabled: false }));
    expect(snap.enabled).toBe(false);
    expect(snap.referralCode).toBeNull();
    expect(snap.webLink).toBeNull();
    expect(snap.monthlyIncome).toHaveLength(6);
    expect(db.ensureReferralCode).not.toHaveBeenCalled();
    expect(db.getReferralNetwork).not.toHaveBeenCalled();
  });
});

describe('buildReferralSnapshot — включённая программа', () => {
  beforeEach(() => {
    state.profile = { circle: 2, lockedRateL1Bps: 600, teamMultiplier: false, boostBps: 0, suspended: false };
    state.balance = 31200;
    state.network = [
      { level: 1, total: 23, active: 18, turnoverThisMonthUsdCents: 180000 },
      { level: 2, total: 41, active: 29, turnoverThisMonthUsdCents: 170000 },
      { level: 3, total: 12, active: 8, turnoverThisMonthUsdCents: 60000 },
    ];
    state.income = [
      { level: 1, allTimeUsdCents: 10800, thisMonthUsdCents: 10800 },
      { level: 2, allTimeUsdCents: 3400, thisMonthUsdCents: 3400 },
    ];
    state.earnings = { totalUsdCents: 87600, thisMonthUsdCents: 14800 };
    state.newRefs = { total: 7, active: 5 };
  });

  it('круг/ставки/блокировка ставки', async () => {
    const snap = await buildReferralSnapshot('u1', ctx());
    expect(snap.circle).toMatchObject({ circle: 2, label: 'Партнёр', nextLabel: 'Топ-партнёр', nextThresholdUsdCents: 500000 });
    expect(snap.rates).toEqual({ l1Bps: 600, l2Bps: 200, l3Bps: 100, topL1Bps: 700 });
    expect(snap.rateLockedForever).toBe(true);
  });

  it('уровни сети объединяют count/active/turnover/income + ставку уровня', async () => {
    const snap = await buildReferralSnapshot('u1', ctx());
    expect(snap.levels).toHaveLength(3);
    expect(snap.levels[0]).toEqual({
      level: 1, rateBps: 600, total: 23, active: 18,
      turnoverThisMonthUsdCents: 180000, incomeThisMonthUsdCents: 10800, incomeAllTimeUsdCents: 10800,
    });
    // L3 без income-строки → нули по доходу, но сеть из network.
    expect(snap.levels[2]).toMatchObject({ level: 3, rateBps: 100, total: 12, incomeAllTimeUsdCents: 0 });
  });

  it('прогресс к следующему кругу = оборот сети / порог', async () => {
    const snap = await buildReferralSnapshot('u1', ctx());
    // turnover = 180000+170000+60000 = 410000; порог круга 3 = 500000 → 8200 bps.
    expect(snap.progress.networkTurnoverThisMonthUsdCents).toBe(410000);
    expect(snap.progress.progressBps).toBe(8200);
  });

  it('ссылки строятся из кода + базы + бота', async () => {
    const snap = await buildReferralSnapshot('u1', ctx());
    expect(snap.referralCode).toBe('abc123');
    expect(snap.webLink).toBe('https://x.test/?ref=abc123');
    expect(snap.telegramLink).toBe('https://t.me/mybot?start=ref_abc123');
  });

  it('canPayout=true при привязке TG, не suspended и балансе ≥ минимума', async () => {
    expect((await buildReferralSnapshot('u1', ctx())).canPayout).toBe(true);
    expect((await buildReferralSnapshot('u1', ctx({ telegramLinked: false }))).canPayout).toBe(false);
    state.balance = 500;
    expect((await buildReferralSnapshot('u1', ctx())).canPayout).toBe(false);
    state.balance = 31200;
    state.profile = { circle: 2, lockedRateL1Bps: 600, teamMultiplier: false, boostBps: 0, suspended: true };
    const s = await buildReferralSnapshot('u1', ctx());
    expect(s.suspended).toBe(true);
    expect(s.canPayout).toBe(false);
  });

  it('история мерджит начисления и выводы, сортирует по дате убыв.', async () => {
    state.ledger = [
      { kind: 'commission', level: 1, amountUsdCents: 96, status: 'accrued', createdAt: new Date('2026-06-28T14:32:00Z'), sourceName: 'Михаил А.', serviceName: 'Netflix', customDescription: null },
      { kind: 'commission', level: 2, amountUsdCents: 20, status: 'accrued', createdAt: new Date('2026-06-25T09:15:00Z'), sourceName: 'Ольга К.', serviceName: 'Spotify', customDescription: null },
    ];
    state.payouts = [
      { id: 'p1', amountUsdCents: 20000, status: 'paid', requestedAt: new Date('2026-06-26T14:00:00Z'), settledAt: null },
    ];
    const snap = await buildReferralSnapshot('u1', ctx());
    expect(snap.history.map((h) => h.kind)).toEqual(['commission', 'payout', 'commission']);
    expect(snap.history[0]).toMatchObject({ title: 'Михаил А.', subtitle: 'Ур. 1 · Netflix', amountUsdCents: 96 });
    expect(snap.history[1]).toMatchObject({ kind: 'payout', amountUsdCents: -20000 });
  });

  it('помесячный доход = 6 точек, текущий месяц заполнен', async () => {
    const key = currentMonthKey();
    state.monthly = [{ month: key, usdCents: 14800 }];
    const snap = await buildReferralSnapshot('u1', ctx());
    expect(snap.monthlyIncome).toHaveLength(6);
    expect(snap.monthlyIncome.at(-1)).toEqual({ month: key, usdCents: 14800 });
    expect(snap.monthlyIncome[0]?.usdCents).toBe(0); // старые месяцы — нули
  });

  it('сбой выдачи кода не валит снапшот (graceful, код=null)', async () => {
    state.code = null; // ensureReferralCode бросит
    const snap = await buildReferralSnapshot('u1', ctx());
    expect(snap.referralCode).toBeNull();
    expect(snap.webLink).toBeNull();
    expect(snap.enabled).toBe(true); // остальной снапшот построен
    expect(snap.circle.circle).toBe(2);
  });
});
