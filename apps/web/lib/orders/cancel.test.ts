import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FREEKASSA_ORDER_STATUS, OrderTransitionError } from '@oplati/types';

/**
 * Отмена заказа клиентом (Mini App + кнопка бота). Тесты держат то, что стоит
 * денег и глазами по коду не видно — каждый пункт поставлен разбором ревью
 * 2026-09-07:
 *   1. ownership — `orderId` приходит от клиента и подделываем;
 *   2. заказ с УСПЕШНЫМ платежом не отменяется (деньги приняты);
 *   3. живой счёт СВЕРЯЕТСЯ со шлюзом до захоронения: `poll-payment` не
 *      смотрит платежи моложе 10 минут и к `failed` не возвращается никогда,
 *      поэтому «оплатил → отменил» при потерянном вебхуке иначе теряет деньги
 *      молча;
 *   4. неизвестный статус (шлюз молчит) — отказ, а не захоронение вслепую;
 *   5. холд банка отменять нельзя;
 *   6. заказ берётся под лок, а платёж перечитывается ВНУТРИ транзакции: счёт,
 *      созданный конкурентным `payments/create` в это окно, обязан быть
 *      заклеймён, иначе отменённый заказ остаётся с живым платежом;
 *   7. claim платежа и переход заказа — в ОДНОЙ транзакции и в этом порядке.
 */

// Обязательные ключи для lazy-валидации serverEnv (как в pay-order.test.ts).
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

type OrderLike = { id: string; userId: string; status: string };
type PaymentLike = { id: string; status: string; lastProviderStatus?: number | null };

const TX = { tx: true };

const h = vi.hoisted(() => ({
  state: {
    order: null as OrderLike | null,
    lockedOrder: undefined as OrderLike | null | undefined,
    payments: [] as { id: string; status: string }[],
    /** Платёж, видимый ДО транзакции (снапшот). */
    pendingBefore: null as PaymentLike | null,
    /** Платёж, видимый ВНУТРИ транзакции (под локом) — по умолчанию тот же. */
    pendingInTx: undefined as PaymentLike | null | undefined,
    /** Списание баллов по заказу; null — списания не было. */
    redemption: null as { discountKopecks: number; status: string } | null,
  },
  claimPaymentTerminal: vi.fn(),
  // Сигнатура нужна типам: тест читает второй аргумент (вход перехода).
  transitionOrder: vi.fn(async (_db: unknown, _input: Record<string, unknown>) => ({})),
  lockOrderForUpdate: vi.fn(),
  pollPaymentOnce: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

let pendingCalls = 0;

vi.mock('@oplati/db', () => ({
  getDb: () => ({ transaction: async (fn: (tx: unknown) => unknown) => fn(TX) }),
  getOrderById: vi.fn(async () => h.state.order),
  findPaymentsByOrderId: vi.fn(async () => h.state.payments),
  findPendingPaymentByOrderId: vi.fn(async () => {
    // Первый вызов — снапшот до транзакции, второй — перечитывание под локом.
    pendingCalls += 1;
    if (pendingCalls === 1) return h.state.pendingBefore;
    return h.state.pendingInTx === undefined ? h.state.pendingBefore : h.state.pendingInTx;
  }),
  claimPaymentTerminal: h.claimPaymentTerminal,
  transitionOrder: h.transitionOrder,
  lockOrderForUpdate: h.lockOrderForUpdate,
  // Списание баллов: возвращается ПРАВИЛОМ (`balanceExpr`), отмена его не
  // снимает — читает только ради текста «баллы вернулись».
  findRedemptionByOrderId: vi.fn(async () => h.state.redemption ?? null),
}));

vi.mock('../jobs/poll-payment-one.ts', () => ({ pollPaymentOnce: h.pollPaymentOnce }));
vi.mock('@sentry/nextjs', () => ({
  captureException: h.captureException,
  captureMessage: h.captureMessage,
}));

import { cancelOrderByClient } from './cancel.ts';

const payable = (status = 'ready_for_payment'): OrderLike => ({ id: 'o1', userId: 'u1', status });

beforeEach(() => {
  vi.clearAllMocks();
  pendingCalls = 0;
  h.state.order = payable();
  h.state.lockedOrder = undefined;
  h.state.payments = [];
  h.state.pendingBefore = null;
  h.state.pendingInTx = undefined;
  h.state.redemption = null;
  h.claimPaymentTerminal.mockResolvedValue({ id: 'p1', status: 'failed' });
  h.transitionOrder.mockResolvedValue({});
  h.lockOrderForUpdate.mockImplementation(async () =>
    h.state.lockedOrder === undefined ? h.state.order : h.state.lockedOrder,
  );
  h.pollPaymentOnce.mockResolvedValue('skipped');
});

const cancel = () => cancelOrderByClient({ userId: 'u1', orderId: 'o1', source: 'cabinet' });

describe('ownership', () => {
  it('чужой заказ неотличим от несуществующего и не отменяется', async () => {
    h.state.order = { id: 'o1', userId: 'someone-else', status: 'ready_for_payment' };

    const res = await cancel();

    expect(res).toEqual({ ok: false, error: 'not_found', message: 'Заказ не найден.' });
    expect(h.transitionOrder).not.toHaveBeenCalled();
    // Подделку callback_data не прячем в тишину.
    expect(h.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('несуществующий заказ — тот же отказ, но без алёрта', async () => {
    h.state.order = null;

    const res = await cancel();

    expect(res.ok).toBe(false);
    expect(h.captureMessage).not.toHaveBeenCalled();
  });
});

describe('что отменять нельзя', () => {
  it('оплаченный заказ: отказ с текстом про оплату, статус не трогаем', async () => {
    h.state.order = payable('paid');

    const res = await cancel();

    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('not_cancellable');
    expect(res.message).toContain('оплачен');
    expect(h.transitionOrder).not.toHaveBeenCalled();
  });

  it('уже отменённый заказ говорит об этом прямо', async () => {
    h.state.order = payable('cancelled');

    const res = await cancel();

    if (res.ok) throw new Error('unreachable');
    expect(res.message).toBe('Заказ уже отменён.');
  });

  it('успешный платёж при заказе в pending_payment — отмену не проводим', async () => {
    h.state.order = payable('pending_payment');
    h.state.payments = [{ id: 'p1', status: 'succeeded' }];

    const res = await cancel();

    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('payment_in_progress');
    expect(h.claimPaymentTerminal).not.toHaveBeenCalled();
    expect(h.transitionOrder).not.toHaveBeenCalled();
  });

  it('платёж на антифрод-холде: деньги на проверке банка не хороним', async () => {
    h.state.order = payable('pending_payment');
    h.state.payments = [{ id: 'p1', status: 'pending' }];
    h.state.pendingBefore = {
      id: 'p1',
      status: 'pending',
      lastProviderStatus: FREEKASSA_ORDER_STATUS.ANTIFRAUD_HOLD,
    };

    const res = await cancel();

    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('not_cancellable');
    expect(res.message).toContain('Банк проверяет платёж');
    // До шлюза даже не идём — статус холда у нас уже записан.
    expect(h.pollPaymentOnce).not.toHaveBeenCalled();
    expect(h.claimPaymentTerminal).not.toHaveBeenCalled();
  });
});

describe('сверка со шлюзом перед захоронением счёта', () => {
  beforeEach(() => {
    h.state.order = payable('pending_payment');
    h.state.payments = [{ id: 'p1', status: 'pending' }];
    h.state.pendingBefore = { id: 'p1', status: 'pending', lastProviderStatus: null };
  });

  it('спрашивает шлюз ДО claim, не трогая терминальные статусы', async () => {
    await cancel();

    expect(h.pollPaymentOnce).toHaveBeenCalledWith(h.state.pendingBefore, { applyTerminal: false });
    const pollOrder = h.pollPaymentOnce.mock.invocationCallOrder[0] ?? 0;
    const claimOrder = h.claimPaymentTerminal.mock.invocationCallOrder[0] ?? 0;
    expect(pollOrder).toBeLessThan(claimOrder);
  });

  it('шлюз говорит «оплачено» — заказ не отменяем', async () => {
    h.pollPaymentOnce.mockResolvedValue('recovered');

    const res = await cancel();

    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('payment_in_progress');
    expect(res.message).toContain('прошла');
    expect(h.claimPaymentTerminal).not.toHaveBeenCalled();
    expect(h.transitionOrder).not.toHaveBeenCalled();
  });

  it('шлюз недоступен — fail-closed: счёт не хороним вслепую', async () => {
    h.pollPaymentOnce.mockResolvedValue('error');

    const res = await cancel();

    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('verification_failed');
    expect(h.claimPaymentTerminal).not.toHaveBeenCalled();
    expect(h.transitionOrder).not.toHaveBeenCalled();
  });

  it('заказа без счёта сверка не касается — к шлюзу не ходим', async () => {
    h.state.order = payable('ready_for_payment');
    h.state.payments = [];
    h.state.pendingBefore = null;

    const res = await cancel();

    expect(res).toMatchObject({ ok: true, invoiceClosed: false });
    expect(h.pollPaymentOnce).not.toHaveBeenCalled();
  });
});

describe('запись под локом', () => {
  it('лок берётся первым действием транзакции, до чтения платежа и записи', async () => {
    await cancel();

    const lockOrder = h.lockOrderForUpdate.mock.invocationCallOrder[0] ?? 0;
    const transitionCallOrder = h.transitionOrder.mock.invocationCallOrder[0] ?? 0;
    expect(lockOrder).toBeLessThan(transitionCallOrder);
    // Лок и переход — в одной транзакции: тот же объект `tx`.
    expect(h.lockOrderForUpdate.mock.calls[0]?.[0]).toBe(TX);
    expect(h.transitionOrder.mock.calls[0]?.[0]).toBe(TX);
  });

  it('статус, сменившийся пока ходили к шлюзу, отменять не даёт', async () => {
    // Холд увёл заказ в payment_review, пока шла сверка.
    h.state.order = payable('pending_payment');
    h.state.payments = [{ id: 'p1', status: 'pending' }];
    h.state.pendingBefore = { id: 'p1', status: 'pending', lastProviderStatus: null };
    h.state.lockedOrder = payable('payment_review');

    const res = await cancel();

    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('not_cancellable');
    expect(res.message).toContain('Банк проверяет платёж');
    expect(h.claimPaymentTerminal).not.toHaveBeenCalled();
    expect(h.transitionOrder).not.toHaveBeenCalled();
  });

  it('счёт, выставленный в окно между снапшотом и локом, всё равно хоронится', async () => {
    // Снапшот: платежа нет. Под локом: `payments/create` успел закоммитить счёт.
    h.state.pendingBefore = null;
    h.state.pendingInTx = { id: 'p-new', status: 'pending', lastProviderStatus: null };

    const res = await cancel();

    expect(res).toMatchObject({ ok: true, invoiceClosed: true });
    expect(h.claimPaymentTerminal).toHaveBeenCalledTimes(1);
    expect(h.claimPaymentTerminal.mock.calls[0]?.[1]).toBe('p-new');
  });

  it('хоронит счёт ДО перехода заказа и в одной транзакции', async () => {
    h.state.order = payable('pending_payment');
    h.state.payments = [{ id: 'p1', status: 'pending' }];
    h.state.pendingBefore = { id: 'p1', status: 'pending', lastProviderStatus: null };

    const res = await cancel();

    expect(res).toMatchObject({ ok: true, invoiceClosed: true });
    const claimOrder = h.claimPaymentTerminal.mock.invocationCallOrder[0] ?? 0;
    const transitionCallOrder = h.transitionOrder.mock.invocationCallOrder[0] ?? 0;
    expect(claimOrder).toBeLessThan(transitionCallOrder);
    expect(h.claimPaymentTerminal.mock.calls[0]?.[0]).toBe(TX);
    expect(h.transitionOrder.mock.calls[0]?.[0]).toBe(TX);
  });

  it('успех пишет user_cancelled с каналом отмены', async () => {
    await cancelOrderByClient({ userId: 'u1', orderId: 'o1', source: 'telegram_inline_button' });

    expect(h.transitionOrder.mock.calls[0]?.[1]).toMatchObject({
      orderId: 'o1',
      toStatus: 'cancelled',
      actorType: 'user',
      eventType: 'user_cancelled',
      payload: { source: 'telegram_inline_button', fromStatus: 'ready_for_payment' },
    });
  });

  it('успех со счётом не обещает, что счёт закрыт у шлюза', async () => {
    h.state.order = payable('pending_payment');
    h.state.payments = [{ id: 'p1', status: 'pending' }];
    h.state.pendingBefore = { id: 'p1', status: 'pending', lastProviderStatus: null };

    const res = await cancel();

    if (!res.ok) throw new Error('unreachable');
    expect(res.message).not.toContain('счёт закрыт');
    expect(res.message).toContain('старой ссылке');
  });

  it('проигранный claim (платёж увели) отменять заказ не даёт', async () => {
    h.state.order = payable('pending_payment');
    h.state.payments = [{ id: 'p1', status: 'pending' }];
    h.state.pendingBefore = { id: 'p1', status: 'pending', lastProviderStatus: null };
    h.claimPaymentTerminal.mockResolvedValue(null);

    const res = await cancel();

    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('payment_in_progress');
    expect(h.transitionOrder).not.toHaveBeenCalled();
  });
});

describe('гонка со сменой статуса', () => {
  it('запрещённый переход не падает 500, а объясняет фактический статус', async () => {
    h.transitionOrder.mockRejectedValue(new OrderTransitionError('o1', 'expired', 'cancelled'));

    const res = await cancel();

    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('not_cancellable');
    expect(res.message).toContain('истёк');
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('неожиданный сбой уходит в Sentry и возвращает failed', async () => {
    h.transitionOrder.mockRejectedValue(new Error('БД лежит'));

    const res = await cancel();

    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('failed');
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});

/**
 * Списание баллов возвращается ПРАВИЛОМ (`balanceExpr` не считает резерв под
 * заказом в `cancelled`), а не вызовом. Отмена обязана про это СКАЗАТЬ:
 * молчаливый возврат клиент прочтёт как «баллы сгорели» (решение Q13).
 */
describe('отмена заказа со списанными баллами', () => {
  it('текст прямо говорит, что баллы вернулись на баланс', async () => {
    h.state.order = payable();
    h.lockOrderForUpdate.mockResolvedValue(payable());
    h.state.redemption = { discountKopecks: 28_600, status: 'reserved' };

    const res = await cancelOrderByClient({ orderId: 'o1', userId: 'u1', source: 'cabinet' });

    expect(res.ok).toBe(true);
    expect(res.ok && res.message).toContain('Баллы вернулись на баланс');
    expect(res.ok && res.message).toContain('286 ₽');
  });

  it('заказ без списания про баллы не говорит ничего', async () => {
    h.state.order = payable();
    h.lockOrderForUpdate.mockResolvedValue(payable());

    const res = await cancelOrderByClient({ orderId: 'o1', userId: 'u1', source: 'cabinet' });

    expect(res.ok && res.message).not.toContain('Баллы');
  });

  it('уже возвращённое списание вторично не обещается', async () => {
    h.state.order = payable();
    h.lockOrderForUpdate.mockResolvedValue(payable());
    h.state.redemption = { discountKopecks: 28_600, status: 'released' };

    const res = await cancelOrderByClient({ orderId: 'o1', userId: 'u1', source: 'cabinet' });

    expect(res.ok && res.message).not.toContain('Баллы');
  });
});
