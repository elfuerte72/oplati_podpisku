import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrderTransitionError } from '@oplati/types';

/**
 * Отмена заказа клиентом («Отменить заказ» в Mini App). Тесты держат ровно то,
 * что стоит денег и глазами по UI не проверяется:
 *   1. ownership — `orderId` приходит от клиента и подделываем;
 *   2. заказ с УСПЕШНЫМ платежом не отменяется (деньги приняты);
 *   3. живой счёт хоронится ПЕРЕД заказом — иначе вебхук, пришедший в окно
 *      между двумя записями, клеймит оплату и упирается в запрещённый переход
 *      `cancelled → paid`: деньги у нас, заказ мёртв, вернуть его нечем;
 *   4. проигранный claim платежа НЕ отменяет заказ (оплата в процессе).
 */

// Обязательные ключи для lazy-валидации serverEnv (как в pay-order.test.ts).
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

type OrderLike = { id: string; userId: string; status: string };
type PaymentLike = { id: string; status: string };

const h = vi.hoisted(() => ({
  state: {
    order: null as OrderLike | null,
    payments: [] as PaymentLike[],
    pendingPayment: null as PaymentLike | null,
  },
  claimPaymentTerminal: vi.fn(),
  // Сигнатура нужна типам: тест читает второй аргумент (вход перехода), а у
  // `vi.fn()` без параметров кортеж вызовов пуст и индекс не типизируется.
  transitionOrder: vi.fn(async (_db: unknown, _input: Record<string, unknown>) => ({})),
  captureException: vi.fn(),
}));

vi.mock('@oplati/db', () => ({
  // Транзакция прозрачная: моки claim/transition сами по себе атомарности не
  // проверяют, а нам нужен порядок вызовов и то, что оба идут под одной.
  getDb: () => ({ transaction: async (fn: (tx: unknown) => unknown) => fn({ tx: true }) }),
  getOrderById: vi.fn(async () => h.state.order),
  findPaymentsByOrderId: vi.fn(async () => h.state.payments),
  findPendingPaymentByOrderId: vi.fn(async () => h.state.pendingPayment),
  claimPaymentTerminal: h.claimPaymentTerminal,
  transitionOrder: h.transitionOrder,
  appendOrderEvent: vi.fn(async () => undefined),
  findCardByIdForUser: vi.fn(async () => null),
  getOrCreateActiveConversation: vi.fn(async () => ({ id: 'c1' })),
  getServiceById: vi.fn(async () => null),
  getUserProfileById: vi.fn(async () => null),
  hasRecentOrderEvent: vi.fn(async () => false),
}));

vi.mock('../catalog/propose.ts', () => ({ proposeFromCatalog: vi.fn() }));
vi.mock('../telegram/support.ts', () => ({ sendToSupportOperator: vi.fn(async () => true) }));
vi.mock('@sentry/nextjs', () => ({
  captureException: h.captureException,
  captureMessage: vi.fn(),
}));

import { cancelOrder } from './actions.ts';

beforeEach(() => {
  vi.clearAllMocks();
  h.state.order = { id: 'o1', userId: 'u1', status: 'ready_for_payment' };
  h.state.payments = [];
  h.state.pendingPayment = null;
  h.claimPaymentTerminal.mockResolvedValue({ id: 'p1', status: 'failed' });
  h.transitionOrder.mockResolvedValue({});
});

describe('cancelOrder — ownership', () => {
  it('чужой заказ неотличим от несуществующего и не отменяется', async () => {
    h.state.order = { id: 'o1', userId: 'someone-else', status: 'ready_for_payment' };

    const res = await cancelOrder('u1', 'o1');

    expect(res).toEqual({ ok: false, error: 'not_found', message: 'Заказ не найден.' });
    expect(h.transitionOrder).not.toHaveBeenCalled();
  });

  it('несуществующий заказ — тот же отказ', async () => {
    h.state.order = null;

    const res = await cancelOrder('u1', 'o1');

    expect(res.ok).toBe(false);
    expect(h.transitionOrder).not.toHaveBeenCalled();
  });
});

describe('cancelOrder — что отменять нельзя', () => {
  it('оплаченный заказ: отказ с текстом про оплату, статус не трогаем', async () => {
    h.state.order = { id: 'o1', userId: 'u1', status: 'paid' };

    const res = await cancelOrder('u1', 'o1');

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('not_cancellable');
    expect(res.message).toContain('оплачен');
    expect(h.transitionOrder).not.toHaveBeenCalled();
  });

  it('уже отменённый заказ говорит об этом прямо', async () => {
    h.state.order = { id: 'o1', userId: 'u1', status: 'cancelled' };

    const res = await cancelOrder('u1', 'o1');

    if (res.ok) throw new Error('unreachable');
    expect(res.message).toBe('Заказ уже отменён.');
  });

  it('успешный платёж при заказе в pending_payment — отмену не проводим', async () => {
    // Рассинхрон: деньги приняты, заказ ещё не доехал до `paid` (вебхук в
    // процессе). Отмена сожгла бы ОПЛАЧЕННЫЙ заказ.
    h.state.order = { id: 'o1', userId: 'u1', status: 'pending_payment' };
    h.state.payments = [{ id: 'p1', status: 'succeeded' }];

    const res = await cancelOrder('u1', 'o1');

    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('payment_in_progress');
    expect(h.transitionOrder).not.toHaveBeenCalled();
    expect(h.claimPaymentTerminal).not.toHaveBeenCalled();
  });
});

describe('cancelOrder — заказ без выставленного счёта', () => {
  it('переводит в cancelled событием user_cancelled и не трогает платежи', async () => {
    const res = await cancelOrder('u1', 'o1');

    expect(res).toMatchObject({ ok: true, invoiceClosed: false });
    expect(h.claimPaymentTerminal).not.toHaveBeenCalled();
    expect(h.transitionOrder).toHaveBeenCalledTimes(1);
    expect(h.transitionOrder.mock.calls[0]?.[1]).toMatchObject({
      orderId: 'o1',
      toStatus: 'cancelled',
      actorType: 'user',
      eventType: 'user_cancelled',
    });
  });
});

describe('cancelOrder — заказ с живым счётом', () => {
  beforeEach(() => {
    h.state.order = { id: 'o1', userId: 'u1', status: 'pending_payment' };
    h.state.payments = [{ id: 'p1', status: 'pending' }];
    h.state.pendingPayment = { id: 'p1', status: 'pending' };
  });

  it('хоронит счёт ДО перехода заказа', async () => {
    const res = await cancelOrder('u1', 'o1');

    expect(res).toMatchObject({ ok: true, invoiceClosed: true });
    expect(h.claimPaymentTerminal).toHaveBeenCalledTimes(1);
    // Порядок — суть инварианта: платёж сначала, заказ следом.
    const claimOrder = h.claimPaymentTerminal.mock.invocationCallOrder[0] ?? 0;
    const transitionCallOrder = h.transitionOrder.mock.invocationCallOrder[0] ?? 0;
    expect(claimOrder).toBeLessThan(transitionCallOrder);
  });

  it('проигранный claim (платёж увели) отменять заказ не даёт', async () => {
    h.claimPaymentTerminal.mockResolvedValue(null);

    const res = await cancelOrder('u1', 'o1');

    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('payment_in_progress');
    expect(h.transitionOrder).not.toHaveBeenCalled();
  });

  it('победивший вебхук виден клиенту как «оплата прошла»', async () => {
    h.claimPaymentTerminal.mockResolvedValue(null);
    // На входе платёж ещё pending (иначе сработал бы ранний гейт), а к
    // перечитыванию после проигранного claim'а он уже succeeded.
    const { findPaymentsByOrderId } = await import('@oplati/db');
    vi.mocked(findPaymentsByOrderId)
      .mockResolvedValueOnce([{ id: 'p1', status: 'pending' }] as never)
      .mockResolvedValueOnce([{ id: 'p1', status: 'succeeded' }] as never);

    const res = await cancelOrder('u1', 'o1');

    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('payment_in_progress');
    expect(res.message).toContain('прошла');
  });
});

describe('cancelOrder — гонка со сменой статуса', () => {
  it('запрещённый переход не падает 500, а объясняет фактический статус', async () => {
    // Заказ похоронил крон между проверкой и переходом.
    h.transitionOrder.mockRejectedValue(new OrderTransitionError('o1', 'expired', 'cancelled'));

    const res = await cancelOrder('u1', 'o1');

    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('not_cancellable');
    expect(res.message).toContain('истёк');
    // Не наша ошибка — в Sentry не шлём.
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('неожиданный сбой уходит в Sentry и возвращает failed', async () => {
    h.transitionOrder.mockRejectedValue(new Error('БД лежит'));

    const res = await cancelOrder('u1', 'o1');

    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('failed');
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});
