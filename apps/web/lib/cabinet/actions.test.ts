import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Действия кабинета (Mini App) — 387 строк без тестов до аудита 2026-08-10.
 * Здесь два инварианта, которые нельзя проверить глазами по UI:
 *   1. ownership — `orderId` приходит от клиента и подделываем; личность даёт
 *      только проверенная `initData`;
 *   2. серверный гейт `status='completed'` — кнопки пост-выпускного флоу UI
 *      прячет, но запрос к API можно послать и без UI.
 * `payOrder` покрыт отдельно (`pay-order.test.ts`) — здесь остальные три.
 */

type OrderLike = {
  id: string;
  userId: string;
  status: string;
  shortId: string;
  amountRub: number | null;
  serviceId: string | null;
  cardId: string | null;
  customServiceDescription: string | null;
  parameters: Record<string, unknown> | null;
};

const h = vi.hoisted(() => ({
  state: {
    order: null as OrderLike | null,
    recentEvent: false,
    delivered: true,
  },
  appendOrderEvent: vi.fn(async () => undefined),
  hasRecentOrderEvent: vi.fn(),
  transitionOrder: vi.fn(async () => ({})),
  findPaymentsByOrderId: vi.fn(async () => [
    { id: 'pay-1', lastProviderStatus: 7, lastProviderStatusAt: new Date() },
  ]),
  sendToSupportOperator: vi.fn(),
  proposeFromCatalog: vi.fn(),
  getOrCreateActiveConversation: vi.fn(async () => ({ id: 'conv-1' })),
  captureException: vi.fn(),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  getOrderById: vi.fn(async () => h.state.order),
  appendOrderEvent: h.appendOrderEvent,
  hasRecentOrderEvent: h.hasRecentOrderEvent,
  transitionOrder: h.transitionOrder,
  findCardByIdForUser: vi.fn(async () => null),
  findPaymentsByOrderId: h.findPaymentsByOrderId,
  findPendingPaymentByOrderId: vi.fn(async () => null),
  getServiceById: vi.fn(async () => ({ name: 'Spotify' })),
  getUserProfileById: vi.fn(async () => ({ displayName: 'Тест' })),
  getOrCreateActiveConversation: h.getOrCreateActiveConversation,
}));

vi.mock('../telegram/support.ts', () => ({
  sendToSupportOperator: h.sendToSupportOperator,
}));

vi.mock('../catalog/propose.ts', () => ({
  proposeFromCatalog: h.proposeFromCatalog,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: h.captureException,
  captureMessage: vi.fn(),
}));

import {
  markSubscriptionActivated,
  proposeNewOrder,
  reportPaymentIssue,
  reportPaymentProblem,
} from './actions.ts';

function completedOrder(overrides: Partial<OrderLike> = {}): OrderLike {
  return {
    id: 'order-1',
    userId: 'user-1',
    status: 'completed',
    shortId: 'ORD-AB12',
    amountRub: 249000,
    serviceId: 'svc-1',
    cardId: null,
    customServiceDescription: null,
    parameters: { tierName: 'Premium' },
    ...overrides,
  };
}

beforeEach(() => {
  h.state.order = completedOrder();
  h.appendOrderEvent.mockClear();
  h.hasRecentOrderEvent.mockReset().mockResolvedValue(false);
  h.sendToSupportOperator.mockReset().mockResolvedValue(true);
  h.proposeFromCatalog.mockReset();
  h.captureException.mockClear();
});

describe('reportPaymentIssue — ownership', () => {
  it('чужой заказ → not_found, оператору ничего не уходит', async () => {
    h.state.order = completedOrder({ userId: 'someone-else' });
    const res = await reportPaymentIssue('user-1', '555', 'order-1', 'card_declined');
    expect(res).toMatchObject({ ok: false, error: 'not_found' });
    expect(h.sendToSupportOperator).not.toHaveBeenCalled();
    expect(h.appendOrderEvent).not.toHaveBeenCalled();
  });

  it('несуществующий заказ → not_found', async () => {
    h.state.order = null;
    const res = await reportPaymentIssue('user-1', '555', 'nope', 'card_declined');
    expect(res).toMatchObject({ ok: false, error: 'not_found' });
  });
});

describe('reportPaymentIssue — серверный гейт completed', () => {
  it.each(['draft', 'ready_for_payment', 'pending_payment', 'paid', 'in_fulfillment', 'expired'])(
    'статус %s не пускает жалобу (UI кнопку прячет, но API открыт)',
    async (status) => {
      h.state.order = completedOrder({ status });
      const res = await reportPaymentIssue('user-1', '555', 'order-1', 'card_declined');
      expect(res).toMatchObject({ ok: false, error: 'not_available' });
      expect(h.appendOrderEvent).not.toHaveBeenCalled();
    },
  );

  it('completed — жалоба уходит оператору и пишется событие', async () => {
    const res = await reportPaymentIssue('user-1', '555', 'order-1', 'card_declined', 'не проходит');
    expect(res).toEqual({ ok: true, duplicate: false });
    expect(h.sendToSupportOperator).toHaveBeenCalledTimes(1);
    expect(h.appendOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderId: 'order-1', actorType: 'user' }),
    );
  });
});

describe('reportPaymentIssue — дедуп и доставка', () => {
  it('повтор в окне дедупа не спамит оператора и не плодит событий', async () => {
    h.hasRecentOrderEvent.mockResolvedValueOnce(true);
    const res = await reportPaymentIssue('user-1', '555', 'order-1', 'card_declined');
    expect(res).toEqual({ ok: true, duplicate: true });
    expect(h.sendToSupportOperator).not.toHaveBeenCalled();
    expect(h.appendOrderEvent).not.toHaveBeenCalled();
  });

  it('недоставленная жалоба НЕ пишет событие: иначе клиент увидел бы «проблема принята», а оператор — ничего', async () => {
    h.sendToSupportOperator.mockResolvedValueOnce(false);
    const res = await reportPaymentIssue('user-1', '555', 'order-1', 'card_declined');
    expect(res).toMatchObject({ ok: false, error: 'failed' });
    expect(h.appendOrderEvent).not.toHaveBeenCalled();
  });

  it('битые parameters не роняют жалобу — просто без тарифа', async () => {
    h.state.order = completedOrder({ parameters: { tierName: 42 } as Record<string, unknown> });
    const res = await reportPaymentIssue('user-1', '555', 'order-1', 'card_declined');
    expect(res).toEqual({ ok: true, duplicate: false });
  });

  it('сбой доставки бросил → failed + Sentry, а не 500 наружу', async () => {
    h.sendToSupportOperator.mockRejectedValueOnce(new Error('telegram 403'));
    const res = await reportPaymentIssue('user-1', '555', 'order-1', 'card_declined');
    expect(res).toMatchObject({ ok: false, error: 'failed' });
    expect(h.captureException).toHaveBeenCalled();
  });
});

describe('markSubscriptionActivated', () => {
  it('чужой заказ → not_found', async () => {
    h.state.order = completedOrder({ userId: 'someone-else' });
    const res = await markSubscriptionActivated('user-1', 'order-1');
    expect(res).toMatchObject({ ok: false, error: 'not_found' });
    expect(h.appendOrderEvent).not.toHaveBeenCalled();
  });

  it('не completed → not_available', async () => {
    h.state.order = completedOrder({ status: 'paid' });
    const res = await markSubscriptionActivated('user-1', 'order-1');
    expect(res).toMatchObject({ ok: false, error: 'not_available' });
    expect(h.appendOrderEvent).not.toHaveBeenCalled();
  });

  it('первое нажатие пишет событие', async () => {
    const res = await markSubscriptionActivated('user-1', 'order-1');
    expect(res).toEqual({ ok: true });
    expect(h.appendOrderEvent).toHaveBeenCalledTimes(1);
  });

  it('идемпотентно: повтор не плодит событий в append-only таблице', async () => {
    h.hasRecentOrderEvent.mockResolvedValueOnce(true);
    const res = await markSubscriptionActivated('user-1', 'order-1');
    expect(res).toEqual({ ok: true });
    expect(h.appendOrderEvent).not.toHaveBeenCalled();
  });

  it('окно проверки повтора — не «последние минуты», а вся жизнь заказа', async () => {
    // С коротким окном второе нажатие через час дало бы вторую строку.
    await markSubscriptionActivated('user-1', 'order-1');
    const arg = h.hasRecentOrderEvent.mock.calls[0]?.[1] as { withinMs: number };
    expect(arg.withinMs).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000);
  });
});

describe('proposeNewOrder — цена строго серверная', () => {
  it('успех отдаёт снимок заказа для экрана', async () => {
    h.proposeFromCatalog.mockResolvedValueOnce({
      ok: true,
      card: {
        orderId: 'o1',
        shortId: 'ORD-AB12',
        service: 'Spotify',
        totalKopecks: 249000,
        expiresAt: '2026-08-12T12:00:00.000Z',
      },
    });
    const res = await proposeNewOrder('user-1', { slug: 'spotify', tierName: 'Premium', tierPeriod: 'month' });
    expect(res).toMatchObject({ ok: true, orderId: 'o1', totalKopecks: 249000 });
  });

  it('заказ создаётся на САМОГО пользователя — чужой userId подставить нечем', async () => {
    h.proposeFromCatalog.mockResolvedValueOnce({
      ok: true,
      card: { orderId: 'o1', shortId: 'S', service: 'X', totalKopecks: 1, expiresAt: 'e' },
    });
    await proposeNewOrder('user-1', { slug: 'spotify' });
    expect(h.proposeFromCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', channel: 'telegram' }),
    );
  });

  it('отказ каталога отдаётся его текстом, а не generic-заглушкой', async () => {
    h.proposeFromCatalog.mockResolvedValueOnce({ ok: false, text: 'Сервис временно недоступен.' });
    const res = await proposeNewOrder('user-1', { slug: 'spotify' });
    expect(res).toEqual({ ok: false, error: 'failed', message: 'Сервис временно недоступен.' });
  });

  it('падение внутри → failed + Sentry, без утечки деталей клиенту', async () => {
    h.proposeFromCatalog.mockRejectedValueOnce(new Error('БД лежит'));
    const res = await proposeNewOrder('user-1', { slug: 'spotify' });
    expect(res).toMatchObject({ ok: false, error: 'failed' });
    expect((res as { message: string }).message).not.toContain('БД лежит');
    expect(h.captureException).toHaveBeenCalled();
  });

  it('необязательные поля не проносятся как undefined (exactOptionalPropertyTypes)', async () => {
    h.proposeFromCatalog.mockResolvedValueOnce({
      ok: true,
      card: { orderId: 'o1', shortId: 'S', service: 'X', totalKopecks: 1, expiresAt: 'e' },
    });
    await proposeNewOrder('user-1', { slug: 'spotify' });
    const arg = h.proposeFromCatalog.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(arg, 'tierName')).toBe(false);
    expect(Object.hasOwn(arg, 'amountUsdCents')).toBe(false);
  });
});

describe('reportPaymentProblem («Проблема с оплатой» до выпуска, тикет 10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.order = completedOrder({ status: 'pending_payment' });
    h.hasRecentOrderEvent.mockResolvedValue(false);
    h.sendToSupportOperator.mockResolvedValue(true);
  });

  it('«я оплатил» из pending_payment: заказ уходит «на проверку» + DM со статусом провайдера', async () => {
    const res = await reportPaymentProblem('user-1', '555', 'order-1', 'not_confirmed');

    expect(res.ok).toBe(true);
    expect(h.transitionOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: 'order-1',
        toStatus: 'payment_review',
        actorType: 'user',
      }),
    );
    const dm = String(h.sendToSupportOperator.mock.calls[0]?.[0]);
    expect(dm).toContain('антифрод-холд');
    expect(dm).toContain('ORD-AB12');
  });

  it('свежий «истёкший»: статус не трогается — только DM', async () => {
    h.state.order = completedOrder({ status: 'expired' });
    // findExpiredPayableOrders хоронит по expiresAt — свежесть меряем по нему.
    (h.state.order as OrderLike & { expiresAt?: Date }).expiresAt = new Date(
      Date.now() - 60 * 60 * 1000,
    );

    const res = await reportPaymentProblem('user-1', '555', 'order-1', 'not_confirmed');

    expect(res.ok).toBe(true);
    expect(h.transitionOrder).not.toHaveBeenCalled();
    expect(h.appendOrderEvent).toHaveBeenCalledTimes(1);
  });

  it('давно истёкший заказ — отказ not_available', async () => {
    h.state.order = completedOrder({ status: 'expired' });
    (h.state.order as OrderLike & { expiresAt?: Date }).expiresAt = new Date(
      Date.now() - 5 * 24 * 60 * 60 * 1000,
    );

    const res = await reportPaymentProblem('user-1', '555', 'order-1', 'not_confirmed');
    expect(res).toMatchObject({ ok: false, error: 'not_available' });
  });

  it('«хочу возврат»: никакой автоматики — только событие и DM', async () => {
    const res = await reportPaymentProblem('user-1', '555', 'order-1', 'refund_request');

    expect(res.ok).toBe(true);
    expect(h.transitionOrder).not.toHaveBeenCalled();
    expect(h.appendOrderEvent).toHaveBeenCalledTimes(1);
    if (res.ok) expect(res.text).toContain('карта');
  });

  it('повторное нажатие в течение часа не плодит DM, но переход «я оплатил» делает', async () => {
    // Дедуп глушит только DM: «хочу возврат» → через 10 минут «я оплатил» не
    // должен оставлять заказ тикать к протуханию.
    h.hasRecentOrderEvent.mockResolvedValue(true);

    const res = await reportPaymentProblem('user-1', '555', 'order-1', 'not_confirmed');

    expect(res).toMatchObject({ ok: true, duplicate: true });
    expect(h.sendToSupportOperator).not.toHaveBeenCalled();
    expect(h.transitionOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'payment_review' }),
    );
  });

  it('«другая проблема» — подсказка /support без DM и событий (спека §6.1)', async () => {
    const res = await reportPaymentProblem('user-1', '555', 'order-1', 'other');

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('/support');
    expect(h.sendToSupportOperator).not.toHaveBeenCalled();
    expect(h.appendOrderEvent).not.toHaveBeenCalled();
  });

  it('сбой доставки DM: записей нет — ретрай не упрётся в ложный «уже у оператора»', async () => {
    h.sendToSupportOperator.mockResolvedValueOnce(false);

    const res = await reportPaymentProblem('user-1', '555', 'order-1', 'refund_request');

    expect(res).toMatchObject({ ok: false, error: 'failed' });
    expect(h.appendOrderEvent).not.toHaveBeenCalled();
    expect(h.transitionOrder).not.toHaveBeenCalled();
  });

  it('чужой заказ — not_found (ownership)', async () => {
    const res = await reportPaymentProblem('user-2', '555', 'order-1', 'not_confirmed');
    expect(res).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('выполненный заказ этой кнопке недоступен (фаза после выпуска — у «Не проходит оплата?»)', async () => {
    h.state.order = completedOrder({ status: 'completed' });
    const res = await reportPaymentProblem('user-1', '555', 'order-1', 'not_confirmed');
    expect(res).toMatchObject({ ok: false, error: 'not_available' });
  });
});
