import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ env: { REFERRAL_ENABLED: true } }));
vi.mock('../env.ts', () => ({ serverEnv: hoisted.env }));

vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

type Missing = { orderId: string; paymentId: string };
const dbState = vi.hoisted(() => ({ missing: [] as Missing[], unreversed: [] as string[] }));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  findOrdersMissingReferralAccruals: vi.fn(async () => dbState.missing),
  findOrdersWithUnreversedAccruals: vi.fn(async () => dbState.unreversed),
}));

const reverseState = vi.hoisted(() => ({ throwOn: new Set<string>() }));
vi.mock('../referral/reverse.ts', () => ({
  reverseReferralAccrualsForFailedOrder: vi.fn(async (orderId: string) => {
    if (reverseState.throwOn.has(orderId)) throw new Error('boom');
    return 1;
  }),
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
import { reverseReferralAccrualsForFailedOrder } from '../referral/reverse.ts';

describe('recoverReferralAccruals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.env.REFERRAL_ENABLED = true;
    dbState.missing = [];
    dbState.unreversed = [];
    accrueState.throwOn = new Set();
    reverseState.throwOn = new Set();
  });

  it('досчитывает каждый найденный заказ', async () => {
    dbState.missing = [
      { orderId: 'o1', paymentId: 'p1' },
      { orderId: 'o2', paymentId: 'p2' },
    ];
    const res = await recoverReferralAccruals();
    expect(res).toEqual({ scanned: 2, processed: 2, errors: 0, reversed: 0 });
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
    expect(res).toEqual({ scanned: 3, processed: 2, errors: 1, reversed: 0 });
  });

  it('REFERRAL_ENABLED=false → не сканирует БД', async () => {
    hoisted.env.REFERRAL_ENABLED = false;
    const res = await recoverReferralAccruals();
    expect(res).toEqual({ scanned: 0, processed: 0, errors: 0, reversed: 0 });
    expect(db.findOrdersMissingReferralAccruals).not.toHaveBeenCalled();
    expect(db.findOrdersWithUnreversedAccruals).not.toHaveBeenCalled();
    expect(accrueReferralForPayment).not.toHaveBeenCalled();
  });

  it('нет кандидатов → пустой прогон', async () => {
    const res = await recoverReferralAccruals();
    expect(res).toEqual({ scanned: 0, processed: 0, errors: 0, reversed: 0 });
  });

  // Бэкстоп (R-1.7): inline-вызовов отмены несколько, и забытая точка перехода
  // в failed означает молча завышенный баланс партнёра. Сверка ledger'а ловит
  // расхождение независимо от того, кто его создал.
  it('гасит начисления failed-заказа, который inline-путь пропустил', async () => {
    dbState.unreversed = ['stale-1', 'stale-2'];

    const res = await recoverReferralAccruals();

    expect(res.reversed).toBe(2);
    expect(reverseReferralAccrualsForFailedOrder).toHaveBeenCalledWith('stale-1');
    expect(reverseReferralAccrualsForFailedOrder).toHaveBeenCalledWith('stale-2');
  });

  it('сбой отмены одного заказа не валит прогон и считается в errors', async () => {
    dbState.unreversed = ['ok-1', 'bad-1'];
    reverseState.throwOn = new Set(['bad-1']);

    const res = await recoverReferralAccruals();

    expect(res.reversed).toBe(1);
    expect(res.errors).toBe(1);
  });

  it('добор начислений и сверка отмен независимы: сбой добора не отменяет сверку', async () => {
    dbState.missing = [{ orderId: 'bad', paymentId: 'p1' }];
    accrueState.throwOn = new Set(['bad']);
    dbState.unreversed = ['stale-1'];

    const res = await recoverReferralAccruals();

    expect(res.errors).toBe(1);
    expect(res.reversed).toBe(1);
  });
});
