import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ env: { REFERRAL_ENABLED: true } }));
vi.mock('../env.ts', () => ({ serverEnv: hoisted.env }));

vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

type Missing = { orderId: string; paymentId: string };
const dbState = vi.hoisted(() => ({ missing: [] as Missing[] }));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  findOrdersMissingReferralAccruals: vi.fn(async () => dbState.missing),
}));

const accrueState = vi.hoisted(() => ({ throwOn: new Set<string>() }));
vi.mock('../referral/accrue.ts', () => ({
  accrueReferralForPayment: vi.fn(async ({ orderId }: { orderId: string }) => {
    if (accrueState.throwOn.has(orderId)) throw new Error('boom');
  }),
}));

import { recoverReferralAccruals } from './referral-accrual-recovery.ts';
import { accrueReferralForPayment } from '../referral/accrue.ts';
import * as db from '@oplati/db';

describe('recoverReferralAccruals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.env.REFERRAL_ENABLED = true;
    dbState.missing = [];
    accrueState.throwOn = new Set();
  });

  it('досчитывает каждый найденный заказ', async () => {
    dbState.missing = [
      { orderId: 'o1', paymentId: 'p1' },
      { orderId: 'o2', paymentId: 'p2' },
    ];
    const res = await recoverReferralAccruals();
    expect(res).toEqual({ scanned: 2, processed: 2, errors: 0 });
    expect(accrueReferralForPayment).toHaveBeenCalledTimes(2);
    expect(accrueReferralForPayment).toHaveBeenCalledWith({ orderId: 'o1', paymentId: 'p1' });
  });

  it('один битый заказ не валит прогон (учитывается в errors)', async () => {
    dbState.missing = [
      { orderId: 'o1', paymentId: 'p1' },
      { orderId: 'bad', paymentId: 'p2' },
      { orderId: 'o3', paymentId: 'p3' },
    ];
    accrueState.throwOn = new Set(['bad']);
    const res = await recoverReferralAccruals();
    expect(res).toEqual({ scanned: 3, processed: 2, errors: 1 });
  });

  it('REFERRAL_ENABLED=false → не сканирует БД', async () => {
    hoisted.env.REFERRAL_ENABLED = false;
    const res = await recoverReferralAccruals();
    expect(res).toEqual({ scanned: 0, processed: 0, errors: 0 });
    expect(db.findOrdersMissingReferralAccruals).not.toHaveBeenCalled();
    expect(accrueReferralForPayment).not.toHaveBeenCalled();
  });

  it('нет кандидатов → пустой прогон', async () => {
    const res = await recoverReferralAccruals();
    expect(res).toEqual({ scanned: 0, processed: 0, errors: 0 });
  });
});
