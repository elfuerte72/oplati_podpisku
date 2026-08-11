import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ env: { REFERRAL_ENABLED: true } }));
vi.mock('../env.ts', () => ({ serverEnv: hoisted.env }));

vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const notifyOps = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('../alerts/notify-ops.ts', () => ({ notifyOps }));

type RollupInput = { networkTurnoverUsdCents: number; newActiveReferrals: number };
type Profile = { circle: number; lockedRateL1Bps: number; boostBps: number; suspended: boolean };
const dbState = vi.hoisted(() => ({
  candidates: [] as string[],
  input: {} as Record<string, RollupInput>,
  profile: null as Profile | null,
  telegramId: null as string | null,
  applied: true,
  throwInputFor: new Set<string>(),
  latestRolledUpMonth: null as string | null,
  processedMonths: [] as string[],
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  listReferralRollupCandidates: vi.fn(async () => dbState.candidates),
  getMonthlyRollupInput: vi.fn(async (_db: unknown, userId: string, monthKey: string) => {
    dbState.processedMonths.push(monthKey);
    if (dbState.throwInputFor.has(userId)) throw new Error('boom');
    return dbState.input[userId] ?? { networkTurnoverUsdCents: 0, newActiveReferrals: 0 };
  }),
  getLatestRolledUpMonth: vi.fn(async () => dbState.latestRolledUpMonth),
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
    expect(res).toEqual({
      scanned: 0,
      applied: 0,
      bonuses: 0,
      upgrades: 0,
      errors: 0,
      missedMonths: [],
    });
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

/**
 * Крон стоит на 1-е число месяца в 02:00 UTC. Простой VPS в это окно (рестарт,
 * сеть, обновление) терял месяц прогрессии МОЛЧА: следующий запуск считает
 * только предыдущий месяц, а про дыру не узнаёт никто (аудит 2026-08-10).
 *
 * Считать пропущенный месяц автоматически НЕЛЬЗЯ (ревью 2026-08-11): счётчик
 * «новых активных рефералов» не ограничен сверху по времени, поэтому старый
 * месяц получил бы сегодняшние покупки и спринт-бонус, которого тогда не
 * заработали, — а ledger append-only. Поэтому крон только находит дыру и громко
 * зовёт человека.
 */
describe('rollupReferralMonth: пропущенные месяцы', () => {
  beforeEach(() => {
    dbState.candidates = [];
    dbState.input = {};
    dbState.profile = null;
    dbState.applied = true;
    dbState.throwInputFor = new Set();
    dbState.latestRolledUpMonth = null;
    dbState.processedMonths = [];
    notifyOps.mockClear();
    hoisted.env.REFERRAL_ENABLED = true;
  });

  it('дыра находится и уходит алёртом владельцу', async () => {
    // Последняя обработка — январь; запуск 1 мая. Февраль и март потеряны.
    dbState.latestRolledUpMonth = '2026-01-01';
    const res = await rollupReferralMonth({ now: new Date('2026-05-01T02:00:00Z') });

    expect(res.missedMonths).toEqual(['2026-02-01', '2026-03-01']);
    expect(notifyOps).toHaveBeenCalledOnce();
    expect(String(notifyOps.mock.calls[0]?.[0] ?? '')).toContain('2026-02-01');
  });

  it('пропущенные месяцы НЕ считаются автоматически', async () => {
    // Иначе спринт-бонус выдался бы задним числом по сегодняшним данным.
    dbState.latestRolledUpMonth = '2026-01-01';
    dbState.candidates = ['u1'];
    await rollupReferralMonth({ now: new Date('2026-05-01T02:00:00Z') });

    expect(dbState.processedMonths).toEqual(['2026-04-01']);
  });

  it('без пропусков алёрта нет', async () => {
    dbState.latestRolledUpMonth = '2026-03-01';
    const res = await rollupReferralMonth({ now: new Date('2026-05-01T02:00:00Z') });
    expect(res.missedMonths).toEqual([]);
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it('пустая история пропуском не считается', async () => {
    // Первый запуск программы: истории нет по определению, звать некого.
    dbState.latestRolledUpMonth = null;
    const res = await rollupReferralMonth({ now: new Date('2026-05-01T02:00:00Z') });
    expect(res.missedMonths).toEqual([]);
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it('повторный запуск того же месяца дырой не считается', async () => {
    dbState.latestRolledUpMonth = '2026-04-01';
    const res = await rollupReferralMonth({ now: new Date('2026-05-01T02:00:00Z') });
    expect(res.missedMonths).toEqual([]);
  });
});
