import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ env: { REFERRAL_ENABLED: true } }));
vi.mock('../env.ts', () => ({ serverEnv: hoisted.env }));

vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

type RollupInput = { networkTurnoverUsdCents: number; newActiveReferrals: number };
type Profile = { circle: number; lockedRateL1Bps: number; boostBps: number; suspended: boolean };
const dbState = vi.hoisted(() => ({
  candidates: [] as string[],
  input: {} as Record<string, RollupInput>,
  profile: null as Profile | null,
  telegramId: null as string | null,
  applied: true,
  throwInputFor: new Set<string>(),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  listReferralRollupCandidates: vi.fn(async () => dbState.candidates),
  getMonthlyRollupInput: vi.fn(async (_db: unknown, userId: string) => {
    if (dbState.throwInputFor.has(userId)) throw new Error('boom');
    return dbState.input[userId] ?? { networkTurnoverUsdCents: 0, newActiveReferrals: 0 };
  }),
  getPartnerProfile: vi.fn(async () => dbState.profile),
  getPriorConsecutiveMetMonths: vi.fn(async () => 0),
  applyMonthlyProgression: vi.fn(async () =>
    dbState.applied ? { applied: true, bonusesInserted: 1 } : { applied: false },
  ),
  getUserTelegramId: vi.fn(async () => dbState.telegramId),
}));

const sendMessage = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../telegram/bot.ts', () => ({
  getBot: () => ({ api: { sendMessage } }),
}));

import { computeRollupWindow, rollupReferralMonth } from './referral-rollup.ts';
import * as db from '@oplati/db';

describe('computeRollupWindow', () => {
  it('на 1 августа обрабатывает июль, буст держит до 31 августа', () => {
    const w = computeRollupWindow(new Date('2026-08-01T02:00:00Z'));
    expect(w.monthKey).toBe('2026-07-01');
    expect(w.boostUntil).toBe('2026-08-31');
  });

  it('корректно переходит через границу года (1 января → декабрь)', () => {
    const w = computeRollupWindow(new Date('2026-01-01T02:00:00Z'));
    expect(w.monthKey).toBe('2025-12-01');
    expect(w.boostUntil).toBe('2026-01-31');
  });
});

describe('rollupReferralMonth', () => {
  const now = new Date('2026-08-01T02:00:00Z');

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.env.REFERRAL_ENABLED = true;
    dbState.candidates = [];
    dbState.input = {};
    dbState.profile = null;
    dbState.telegramId = null;
    dbState.applied = true;
    dbState.throwInputFor = new Set();
  });

  it('REFERRAL_ENABLED=false → не сканирует БД', async () => {
    hoisted.env.REFERRAL_ENABLED = false;
    const res = await rollupReferralMonth({ now });
    expect(res).toEqual({ scanned: 0, applied: 0, bonuses: 0, upgrades: 0, errors: 0 });
    expect(db.listReferralRollupCandidates).not.toHaveBeenCalled();
  });

  it('повышает круг и считает бонусы (оборот $2000)', async () => {
    dbState.candidates = ['u1'];
    dbState.input = { u1: { networkTurnoverUsdCents: 200_000, newActiveReferrals: 0 } };
    const res = await rollupReferralMonth({ now });
    expect(res.scanned).toBe(1);
    expect(res.applied).toBe(1);
    expect(res.upgrades).toBe(1); // круг 0→2
    expect(res.bonuses).toBe(1);
    expect(res.errors).toBe(0);
  });

  it('идемпотентно: applied=false → не считается и не уведомляет', async () => {
    dbState.candidates = ['u1'];
    dbState.input = { u1: { networkTurnoverUsdCents: 200_000, newActiveReferrals: 0 } };
    dbState.applied = false;
    dbState.telegramId = '12345';
    const res = await rollupReferralMonth({ now });
    expect(res.applied).toBe(0);
    expect(res.upgrades).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('уведомляет партнёра с Telegram при повышении круга', async () => {
    dbState.candidates = ['u1'];
    dbState.input = { u1: { networkTurnoverUsdCents: 200_000, newActiveReferrals: 0 } };
    dbState.telegramId = '12345';
    await rollupReferralMonth({ now });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Партнёр'));
  });

  it('без повышения и бонусов (оборот 0) — применяет, но не уведомляет', async () => {
    dbState.candidates = ['u1'];
    dbState.telegramId = '12345';
    const res = await rollupReferralMonth({ now });
    expect(res.applied).toBe(1);
    expect(res.upgrades).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('только буст (макс. статус, без бонусов) — уведомляет о бусте', async () => {
    // Партнёр уже на круге 3 (Топ), оборот ≥150% порога ($5000×1.5 = $7500),
    // без новых активных и не серийный месяц → boostGranted, но не upgrade/бонус.
    dbState.candidates = ['u1'];
    dbState.profile = { circle: 3, lockedRateL1Bps: 700, boostBps: 0, suspended: false };
    dbState.input = { u1: { networkTurnoverUsdCents: 750_000, newActiveReferrals: 0 } };
    dbState.telegramId = '12345';
    const res = await rollupReferralMonth({ now });
    expect(res.upgrades).toBe(0); // на макс. статусе повышения нет
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('буст'));
  });

  it('ошибка по одному партнёру не валит прогон', async () => {
    dbState.candidates = ['u1', 'bad', 'u3'];
    dbState.input = {
      u1: { networkTurnoverUsdCents: 0, newActiveReferrals: 0 },
      u3: { networkTurnoverUsdCents: 0, newActiveReferrals: 0 },
    };
    dbState.throwInputFor = new Set(['bad']);
    const res = await rollupReferralMonth({ now });
    expect(res.scanned).toBe(3);
    expect(res.applied).toBe(2);
    expect(res.errors).toBe(1);
  });
});
