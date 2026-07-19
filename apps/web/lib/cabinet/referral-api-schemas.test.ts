import { describe, expect, it } from 'vitest';

import {
  referralErrorResponseSchema,
  referralPayoutResponseSchema,
  referralSnapshotResponseSchema,
} from './referral-api-schemas.ts';

/** Валидный снапшот в форме ответа роута (зеркало ReferralSnapshot). */
const validSnapshot = {
  enabled: true,
  suspended: false,
  telegramLinked: true,
  referralCode: 'abc123',
  telegramLink: 'https://telegram.me/bot?start=ref_abc123',
  circle: {
    circle: 1,
    label: 'Партнёр',
    nextLabel: 'Про-партнёр',
    nextThresholdUsdCents: 50_000,
    achievementBonusUsdCents: 1000,
  },
  rates: { l1Bps: 400, topL1Bps: 700 },
  rateLockedForever: true,
  earnedThisMonthUsdCents: 1234,
  earnedTotalUsdCents: 5678,
  balanceUsdCents: 4321,
  minPayoutUsdCents: 2000,
  canPayout: true,
  progress: {
    networkTurnoverThisMonthUsdCents: 10_000,
    nextThresholdUsdCents: 50_000,
    progressBps: 2000,
  },
  sprint: {
    newReferralsThisMonth: 2,
    newReferralsActive: 1,
    newReferralsGoal: 3,
    turnoverThisMonthUsdCents: 10_000,
    turnoverBoostThresholdUsdCents: 75_000,
  },
  network: {
    total: 5,
    active: 2,
    turnoverThisMonthUsdCents: 10_000,
    incomeThisMonthUsdCents: 400,
    incomeAllTimeUsdCents: 900,
  },
  monthlyIncome: [{ month: '2026-07', usdCents: 400 }],
  history: [
    {
      kind: 'commission',
      title: 'Иван',
      subtitle: 'Spotify Premium',
      amountUsdCents: 80,
      status: 'accrued',
      statusLabel: 'Начислено',
      reversed: false,
      at: '2026-07-18T10:00:00.000Z',
    },
  ],
};

describe('referralSnapshotResponseSchema', () => {
  it('парсит валидный ответ snapshot', () => {
    const r = referralSnapshotResponseSchema.safeParse({ ok: true, snapshot: validSnapshot });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.snapshot.referralCode).toBe('abc123');
  });

  it('отклоняет ответ без снапшота и ошибочные ответы', () => {
    expect(referralSnapshotResponseSchema.safeParse({ ok: true }).success).toBe(false);
    expect(referralSnapshotResponseSchema.safeParse({ ok: false, error: 'unauthorized' }).success).toBe(false);
    expect(referralSnapshotResponseSchema.safeParse(null).success).toBe(false);
  });

  it('отклоняет снапшот с испорченным вложенным блоком', () => {
    const broken = { ...validSnapshot, network: { total: 'пять' } };
    expect(referralSnapshotResponseSchema.safeParse({ ok: true, snapshot: broken }).success).toBe(false);
  });

  it('неизвестный kind в истории → отказ, не тихий мусор в UI', () => {
    const broken = {
      ...validSnapshot,
      history: [{ ...validSnapshot.history[0], kind: 'mystery_bonus' }],
    };
    expect(referralSnapshotResponseSchema.safeParse({ ok: true, snapshot: broken }).success).toBe(false);
  });
});

describe('referralPayoutResponseSchema', () => {
  it('парсит успех и отбрасывает серверные поля вне клиентского контракта', () => {
    const r = referralPayoutResponseSchema.safeParse({
      ok: true,
      payoutId: 'p1',
      amountUsdCents: 2000,
      feeUsdCents: 70,
      netUsdCents: 1930,
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.ok) {
      expect(r.data.payoutId).toBe('p1');
      expect('feeUsdCents' in r.data).toBe(false);
    }
  });

  it('парсит отказ с контекстом below_minimum / insufficient_balance', () => {
    const below = referralPayoutResponseSchema.safeParse({
      ok: false,
      error: 'below_minimum',
      minPayoutUsdCents: 2000,
    });
    expect(below.success).toBe(true);

    const insufficient = referralPayoutResponseSchema.safeParse({
      ok: false,
      error: 'insufficient_balance',
      balanceUsdCents: 100,
    });
    expect(insufficient.success).toBe(true);
  });

  it('отклоняет успех без payoutId (регресс as-каста: раньше проходил)', () => {
    expect(referralPayoutResponseSchema.safeParse({ ok: true }).success).toBe(false);
  });
});

describe('referralErrorResponseSchema', () => {
  it('достаёт код ошибки из любого ошибочного ответа роута', () => {
    expect(referralErrorResponseSchema.safeParse({ ok: false, error: 'rate_limited' }).success).toBe(true);
    expect(referralErrorResponseSchema.safeParse({ error: 'internal_error' }).success).toBe(true);
    expect(referralErrorResponseSchema.safeParse('oops').success).toBe(false);
  });
});
