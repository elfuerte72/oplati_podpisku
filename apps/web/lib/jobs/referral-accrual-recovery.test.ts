import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ env: { REFERRAL_ENABLED: true } }));
vi.mock('../env.ts', () => ({ serverEnv: hoisted.env }));

vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

vi.mock('../alerts/notify-ops.ts', () => ({ notifyOps: vi.fn(async () => {}) }));

type Missing = { orderId: string; paymentId: string };
const dbState = vi.hoisted(() => ({
  missing: [] as Missing[],
  unreversed: [] as { orderId: string; status: string }[],
  negative: [] as { userId: string; balanceUsdCents: number }[],
  underpaid: [] as { orderId: string; status: string }[],
  throwOnStaleSelect: false,
}));
const reverseState = vi.hoisted(() => ({ throwOn: new Set<string>() }));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  findOrdersMissingReferralAccruals: vi.fn(async () => dbState.missing),
  findOrdersWithUnreversedAccruals: vi.fn(async () => {
    if (dbState.throwOnStaleSelect) throw new Error('select boom');
    return dbState.unreversed;
  }),
  findPurchasedOrdersWithReversedAccruals: vi.fn(async () => dbState.underpaid),
  findNegativeReferralBalances: vi.fn(async () => dbState.negative),
  // Репозиторий зовётся напрямую: он БРОСАЕТ при сбое БД, и крон обязан это
  // увидеть (graceful-обёртка вернула бы 0 и спрятала аварию).
  reverseAccrualsForOrder: vi.fn(async (_db: unknown, orderId: string) => {
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

import {
  recoverReferralAccruals,
  resetReferralRecoveryAlertDedupForTests,
} from './referral-accrual-recovery.ts';
import { accrueReferralForPayment } from '../referral/accrue.ts';
import * as db from '@oplati/db';
import { notifyOps } from '../alerts/notify-ops.ts';

describe('recoverReferralAccruals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.env.REFERRAL_ENABLED = true;
    dbState.missing = [];
    dbState.unreversed = [];
    dbState.negative = [];
    dbState.underpaid = [];
    dbState.throwOnStaleSelect = false;
    accrueState.throwOn = new Set();
    reverseState.throwOn = new Set();
    resetReferralRecoveryAlertDedupForTests();
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

  it('REFERRAL_ENABLED=false → добор выключен, но сверка отмен идёт', async () => {
    // Флаг — аварийный выключатель ПРОГРАММЫ. Начисления, записанные при
    // включённом, обязаны гаситься и после выключения, иначе они висят на
    // балансе по провалившимся заказам вечно (находка ревью).
    hoisted.env.REFERRAL_ENABLED = false;
    dbState.unreversed = [{ orderId: 'stale-1', status: 'failed' }];

    const res = await recoverReferralAccruals();

    expect(res).toEqual({ scanned: 0, processed: 0, errors: 0, reversed: 1 });
    expect(db.findOrdersMissingReferralAccruals).not.toHaveBeenCalled();
    expect(accrueReferralForPayment).not.toHaveBeenCalled();
    expect(db.findOrdersWithUnreversedAccruals).toHaveBeenCalled();
  });

  it('расхождение ledger уходит владельцу в Telegram, а не только в лог', async () => {
    // Расхождений в норме нет вообще: каждое означает, что какой-то путь
    // перехода в failed остался без отмены. Молчаливый warn в логах живёт
    // незамеченным — это деньги (находка ревью).
    dbState.unreversed = [{ orderId: 'stale-1', status: 'failed' }];

    await recoverReferralAccruals();

    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(notifyOps).mock.calls[0]?.[0])).toMatch(/реферальн/i);
  });

  it('чистый прогон владельца не беспокоит', async () => {
    dbState.unreversed = [];
    dbState.negative = [];

    await recoverReferralAccruals();

    expect(notifyOps).not.toHaveBeenCalled();
  });

  it('сбой БД при сверке виден в errors, а не маскируется нулём', async () => {
    dbState.unreversed = [{ orderId: 'bad-1', status: 'failed' }];
    reverseState.throwOn = new Set(['bad-1']);

    const res = await recoverReferralAccruals();

    expect(res).toEqual({ scanned: 0, processed: 0, errors: 1, reversed: 0 });
  });

  it('нет кандидатов → пустой прогон', async () => {
    const res = await recoverReferralAccruals();
    expect(res).toEqual({ scanned: 0, processed: 0, errors: 0, reversed: 0 });
  });

  // Бэкстоп (R-1.7): inline-вызовов отмены несколько, и забытая точка перехода
  // в failed означает молча завышенный баланс партнёра. Сверка ledger'а ловит
  // расхождение независимо от того, кто его создал.
  it('гасит начисления failed-заказа, который inline-путь пропустил', async () => {
    dbState.unreversed = [
      { orderId: 'stale-1', status: 'failed' },
      { orderId: 'stale-2', status: 'failed' },
    ];

    const res = await recoverReferralAccruals();

    expect(res.reversed).toBe(2);
    expect(db.reverseAccrualsForOrder).toHaveBeenCalledWith(expect.anything(), 'stale-1');
    expect(db.reverseAccrualsForOrder).toHaveBeenCalledWith(expect.anything(), 'stale-2');
  });

  it('сбой отмены одного заказа не валит прогон и считается в errors', async () => {
    dbState.unreversed = [
      { orderId: 'ok-1', status: 'failed' },
      { orderId: 'bad-1', status: 'failed' },
    ];
    reverseState.throwOn = new Set(['bad-1']);

    const res = await recoverReferralAccruals();

    expect(res.reversed).toBe(1);
    expect(res.errors).toBe(1);
  });

  it('повторный прогон не шлёт тот же DM снова (дедуп часа)', async () => {
    // Крон бежит ежечасно, а расхождение живёт до вмешательства человека: без
    // дедупа владелец получал бы одно и то же сообщение бесконечно, и денежный
    // алерт превратился бы в фон (находка ревью). Sentry группирует сам, личка — нет.
    dbState.unreversed = [{ orderId: 'stale-1', status: 'failed' }];
    reverseState.throwOn = new Set(['stale-1']);

    await recoverReferralAccruals();
    await recoverReferralAccruals();

    expect(notifyOps).toHaveBeenCalledTimes(1);
  });

  it('отрицательный баланс: DM тоже под дедупом', async () => {
    dbState.negative = [{ userId: 'u-1', balanceUsdCents: -1000 }];

    await recoverReferralAccruals();
    await recoverReferralAccruals();

    expect(notifyOps).toHaveBeenCalledTimes(1);
  });

  // Зеркальная сверка (находка финального ревью): сторона, где теряет ПАРТНЁР,
  // раньше не проверялась вовсе — сверка смотрела только туда, где теряем мы.
  it('погашенная комиссия по состоявшемуся заказу уходит владельцу в Telegram', async () => {
    dbState.underpaid = [{ orderId: 'ord-1', status: 'completed' }];

    await recoverReferralAccruals();

    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(notifyOps).mock.calls[0]?.[0])).toMatch(/недоплачено/i);
  });

  it('недоплата партнёру: DM под дедупом часа', async () => {
    dbState.underpaid = [{ orderId: 'ord-1', status: 'completed' }];

    await recoverReferralAccruals();
    await recoverReferralAccruals();

    expect(notifyOps).toHaveBeenCalledTimes(1);
  });

  it('сбой зеркальной сверки виден в errors и не валит остальные проверки', async () => {
    vi.mocked(db.findPurchasedOrdersWithReversedAccruals).mockRejectedValueOnce(
      new Error('boom'),
    );
    dbState.negative = [{ userId: 'u-1', balanceUsdCents: -500 }];

    const res = await recoverReferralAccruals();

    expect(res.errors).toBe(1);
    // Проверка отрицательного баланса идёт ПОСЛЕ и обязана отработать.
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(notifyOps).mock.calls[0]?.[0])).toMatch(/отрицательн/i);
  });

  // Выборка stale стояла без перехвата, и её сбой ронял весь прогон вместе с
  // двумя денежными сигналами, которые идут ниже (находка QA).
  it('сбой ВЫБОРКИ stale не гасит зеркальную сверку и проверку баланса', async () => {
    dbState.throwOnStaleSelect = true;
    dbState.negative = [{ userId: 'u-1', balanceUsdCents: -500 }];

    const res = await recoverReferralAccruals();

    expect(res.errors).toBe(1);
    expect(res.reversed).toBe(0);
    expect(db.findNegativeReferralBalances).toHaveBeenCalled();
    expect(notifyOps).toHaveBeenCalledTimes(1);
  });

  it('добор начислений и сверка отмен независимы: сбой добора не отменяет сверку', async () => {
    dbState.missing = [{ orderId: 'bad', paymentId: 'p1' }];
    accrueState.throwOn = new Set(['bad']);
    dbState.unreversed = [{ orderId: 'stale-1', status: 'failed' }];

    const res = await recoverReferralAccruals();

    expect(res.errors).toBe(1);
    expect(res.reversed).toBe(1);
  });
});
