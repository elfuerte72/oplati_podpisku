import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ env: { REFERRAL_ENABLED: true } }));
vi.mock('../env.server.ts', () => ({ serverEnv: hoisted.env }));

vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const dbState = vi.hoisted(() => ({ reversed: 0, throws: false }));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  reverseAccrualsForOrder: vi.fn(async () => {
    if (dbState.throws) throw new Error('БД недоступна');
    return dbState.reversed;
  }),
}));

import * as Sentry from '@sentry/nextjs';
import * as db from '@oplati/db';

import { reverseReferralAccrualsForFailedOrder } from './reverse.ts';

describe('reverseReferralAccrualsForFailedOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.env.REFERRAL_ENABLED = true;
    dbState.reversed = 1;
    dbState.throws = false;
  });

  it('гасит начисления заказа и возвращает их число', async () => {
    expect(await reverseReferralAccrualsForFailedOrder('order-1')).toBe(1);
    expect(db.reverseAccrualsForOrder).toHaveBeenCalledWith(expect.anything(), 'order-1');
  });

  it('REFERRAL_ENABLED=false → в БД не ходит', async () => {
    hoisted.env.REFERRAL_ENABLED = false;
    expect(await reverseReferralAccrualsForFailedOrder('order-1')).toBe(0);
    expect(db.reverseAccrualsForOrder).not.toHaveBeenCalled();
  });

  it('сбой БД не пробрасывается наружу — иначе он сорвал бы перевод заказа в failed', async () => {
    dbState.throws = true;

    await expect(reverseReferralAccrualsForFailedOrder('order-1')).resolves.toBe(0);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('нечего гасить — тихий ноль, без Sentry (штатный случай: заказ без реферера)', async () => {
    dbState.reversed = 0;

    expect(await reverseReferralAccrualsForFailedOrder('order-1')).toBe(0);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
