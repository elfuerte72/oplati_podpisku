import { describe, expect, it } from 'vitest';

import {
  highestCircleForTurnover,
  planMonthlyProgression,
  planThresholdUsdCents,
  REFERRAL_SERIAL_BONUS_USD_CENTS,
  REFERRAL_SPRINT_NEW_REFS_BONUS_USD_CENTS,
  REFERRAL_TURNOVER_BOOST_BPS,
  type MonthlyProgressionInput,
} from './referral-progression.ts';

// Пороги кругов (USD-центы): Старт $500, Партнёр $2000, Топ $5000.
const input = (over: Partial<MonthlyProgressionInput> = {}): MonthlyProgressionInput => ({
  currentCircle: 0,
  lockedRateL1Bps: 400,
  networkTurnoverUsdCents: 0,
  newActiveReferrals: 0,
  activeL2Count: 0,
  priorConsecutiveMetMonths: 0,
  ...over,
});

describe('highestCircleForTurnover', () => {
  it('оборот ниже $500 → круг 0 (Клиент)', () => {
    expect(highestCircleForTurnover(49_999)).toBe(0);
  });
  it('ровно на пороге $500 → круг 1 (Старт)', () => {
    expect(highestCircleForTurnover(50_000)).toBe(1);
  });
  it('$2000 → круг 2 (Партнёр)', () => {
    expect(highestCircleForTurnover(200_000)).toBe(2);
  });
  it('$5000+ → круг 3 (Топ-партнёр)', () => {
    expect(highestCircleForTurnover(600_000)).toBe(3);
  });
});

describe('planThresholdUsdCents — план месяца по кругу', () => {
  it('круг 0 (Клиент) использует порог круга 1 ($500)', () => {
    expect(planThresholdUsdCents(0)).toBe(50_000);
  });
  it('круг 2 → $2000', () => {
    expect(planThresholdUsdCents(2)).toBe(200_000);
  });
});

describe('planMonthlyProgression — храповик круга', () => {
  it('оборот $2000 у Клиента → повышение до круга 2 + фиксация 6%', () => {
    const r = planMonthlyProgression(input({ networkTurnoverUsdCents: 200_000 }));
    expect(r.newCircle).toBe(2);
    expect(r.circleUpgraded).toBe(true);
    expect(r.newLockedRateL1Bps).toBe(600);
  });

  it('храповик не понижает круг при падении оборота', () => {
    const r = planMonthlyProgression(
      input({ currentCircle: 2, lockedRateL1Bps: 600, networkTurnoverUsdCents: 0 }),
    );
    expect(r.newCircle).toBe(2);
    expect(r.circleUpgraded).toBe(false);
    expect(r.newLockedRateL1Bps).toBe(600); // не понижается
  });

  it('скачок 0→3 даёт бонусы всех пройденных кругов ($50 + $150)', () => {
    const r = planMonthlyProgression(input({ networkTurnoverUsdCents: 500_000 }));
    expect(r.newCircle).toBe(3);
    const circleBonuses = r.bonuses.filter((b) => b.kind === 'circle_bonus');
    expect(circleBonuses.map((b) => b.amountUsdCents)).toEqual([5_000, 15_000]);
  });

  it('без повышения — бонуса круга нет', () => {
    const r = planMonthlyProgression(
      input({ currentCircle: 2, lockedRateL1Bps: 600, networkTurnoverUsdCents: 200_000 }),
    );
    expect(r.bonuses.filter((b) => b.kind === 'circle_bonus')).toHaveLength(0);
  });
});

describe('planMonthlyProgression — спринт «новые активные»', () => {
  it('10+ новых активных → бонус $30', () => {
    const r = planMonthlyProgression(input({ newActiveReferrals: 10 }));
    const b = r.bonuses.find((x) => x.kind === 'sprint_new_refs');
    expect(b?.amountUsdCents).toBe(REFERRAL_SPRINT_NEW_REFS_BONUS_USD_CENTS);
  });
  it('9 новых → без бонуса спринта', () => {
    const r = planMonthlyProgression(input({ newActiveReferrals: 9 }));
    expect(r.bonuses.find((x) => x.kind === 'sprint_new_refs')).toBeUndefined();
  });
});

describe('planMonthlyProgression — спринт-буст оборота (150% порога)', () => {
  it('оборот ≥150% порога круга → буст +1% на след. месяц', () => {
    // круг 2, порог $2000, 150% = $3000
    const r = planMonthlyProgression(
      input({ currentCircle: 2, lockedRateL1Bps: 600, networkTurnoverUsdCents: 300_000 }),
    );
    expect(r.boostGranted).toBe(true);
    expect(r.boostBps).toBe(REFERRAL_TURNOVER_BOOST_BPS);
  });
  it('оборот <150% → без буста', () => {
    const r = planMonthlyProgression(
      input({ currentCircle: 2, lockedRateL1Bps: 600, networkTurnoverUsdCents: 299_999 }),
    );
    expect(r.boostGranted).toBe(false);
    expect(r.boostBps).toBe(0);
  });
});

describe('planMonthlyProgression — план и серийный бонус', () => {
  it('оборот ≥ порога → план выполнен, серия растёт', () => {
    const r = planMonthlyProgression(
      input({ currentCircle: 1, lockedRateL1Bps: 400, networkTurnoverUsdCents: 50_000, priorConsecutiveMetMonths: 1 }),
    );
    expect(r.planMet).toBe(true);
    expect(r.consecutiveMetMonths).toBe(2);
  });

  it('план не выполнен → серия обнуляется', () => {
    const r = planMonthlyProgression(
      input({ currentCircle: 1, lockedRateL1Bps: 400, networkTurnoverUsdCents: 10_000, priorConsecutiveMetMonths: 5 }),
    );
    expect(r.planMet).toBe(false);
    expect(r.consecutiveMetMonths).toBe(0);
    expect(r.bonuses.find((b) => b.kind === 'serial_bonus')).toBeUndefined();
  });

  it('3-й месяц подряд у круга 2 → серийный бонус $75', () => {
    const r = planMonthlyProgression(
      input({ currentCircle: 2, lockedRateL1Bps: 600, networkTurnoverUsdCents: 200_000, priorConsecutiveMetMonths: 2 }),
    );
    expect(r.consecutiveMetMonths).toBe(3);
    const b = r.bonuses.find((x) => x.kind === 'serial_bonus');
    expect(b?.amountUsdCents).toBe(REFERRAL_SERIAL_BONUS_USD_CENTS[2]); // $75
  });

  it('4-й месяц подряд (серия не кратна 3) → серийного бонуса нет', () => {
    const r = planMonthlyProgression(
      input({ currentCircle: 2, lockedRateL1Bps: 600, networkTurnoverUsdCents: 200_000, priorConsecutiveMetMonths: 3 }),
    );
    expect(r.consecutiveMetMonths).toBe(4);
    expect(r.bonuses.find((x) => x.kind === 'serial_bonus')).toBeUndefined();
  });

  it('6-й месяц подряд → снова серийный бонус', () => {
    const r = planMonthlyProgression(
      input({ currentCircle: 2, lockedRateL1Bps: 600, networkTurnoverUsdCents: 200_000, priorConsecutiveMetMonths: 5 }),
    );
    expect(r.consecutiveMetMonths).toBe(6);
    expect(r.bonuses.find((x) => x.kind === 'serial_bonus')?.amountUsdCents).toBe(7_500);
  });
});

describe('planMonthlyProgression — командный множитель', () => {
  it('5+ активных L2 → флаг включён', () => {
    expect(planMonthlyProgression(input({ activeL2Count: 5 })).teamMultiplier).toBe(true);
  });
  it('4 активных L2 → флаг выключен (пересчёт каждый месяц)', () => {
    expect(planMonthlyProgression(input({ activeL2Count: 4 })).teamMultiplier).toBe(false);
  });
});

describe('planMonthlyProgression — суммарный бонус', () => {
  it('складывает круг + спринт при одновременном достижении', () => {
    const r = planMonthlyProgression(
      input({ networkTurnoverUsdCents: 200_000, newActiveReferrals: 10 }),
    );
    // круг 0→2: бонус круга 2 = $50, спринт = $30 → $80
    expect(r.totalBonusUsdCents).toBe(5_000 + REFERRAL_SPRINT_NEW_REFS_BONUS_USD_CENTS);
  });
});
