import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Возврат списанных баллов оператором (трек referral-balance-spend, тикет 08).
 *
 * Что здесь держится:
 *   - возврат при `failed` — решение ЧЕЛОВЕКА, не правило (иначе ручная выдача
 *     списала бы баллы повторно и увела баланс клиента в минус);
 *   - повтор идемпотентен: второе нажатие не возвращает дважды и не пишет
 *     второе событие;
 *   - заказ без списания — понятный отказ, а не 500;
 *   - возврат и событие журнала идут в ОДНОЙ транзакции: без автора запись
 *     не отвечает на вопрос «кто вернул деньги клиенту»;
 *   - сорванная доставка сообщения клиенту возврат не откатывает.
 */

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
  getOrderDetail: vi.fn(),
  release: vi.fn(),
  appendEvent: vi.fn(),
  captureException: vi.fn(),
  sendMessage: vi.fn(async () => ({})),
  txSentinel: { __tag: 'tx' } as object,
}));

vi.mock('@/lib/panel/session', () => ({ readPanelActor: h.readPanelActor }));

vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    { get: (_t, prop: string) => (prop === 'PANEL_HOST' ? 'admin.oplatishka.com' : undefined) },
  ),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'admin.oplatishka.com' }),
}));

// `after()` в тестах исполняем сразу — иначе доставка клиенту не проверяется.
vi.mock('next/server', () => ({ after: (fn: () => unknown) => void fn() }));

vi.mock('@oplati/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oplati/db')>();
  return {
    ...actual,
    getDb: () => ({
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(h.txSentinel),
    }),
    getOrderDetailForPanel: h.getOrderDetail,
    releaseBonusReservation: h.release,
    appendOrderEvent: h.appendEvent,
  };
});

vi.mock('@/lib/telegram/bot', () => ({ getBot: () => ({ api: { sendMessage: h.sendMessage } }) }));

vi.mock('@sentry/nextjs', () => ({
  captureException: h.captureException,
  captureMessage: vi.fn(),
}));

import { POST } from './route.ts';

const SHORT_ID = 'ORD-J6TBP';
const STAFF_ID = '00000000-0000-4000-8000-0000000000ff';

function actor(role: 'admin' | 'operator' | 'supervisor') {
  return {
    id: STAFF_ID,
    email: 'op@example.com',
    displayName: 'Менеджер',
    role,
    telegramId: '1',
    lastLoginAt: null,
  };
}

function orderWithBonus(
  over: {
    status?: string;
    bonusStatus?: 'reserved' | 'spent' | 'released' | null;
    telegramId?: string | null;
    hasSucceededPayment?: boolean;
  } = {},
) {
  const bonusStatus = over.bonusStatus === undefined ? 'spent' : over.bonusStatus;
  return {
    hasSucceededPayment: over.hasSucceededPayment ?? true,
    order: { id: 'order-1', shortId: SHORT_ID, status: over.status ?? 'failed' },
    client: { id: 'user-1', telegramId: over.telegramId ?? '777', displayName: null, email: null },
    events: [],
    bonus:
      bonusStatus === null
        ? null
        : {
            amountUsdCents: 354,
            discountKopecks: 28_600,
            status: bonusStatus,
            reservedAt: new Date('2026-09-01T10:00:00Z'),
            settledAt: null,
            releasedByName: null,
          },
  };
}

function request(body: unknown): Request {
  return new Request('https://admin.oplatishka.com/api/panel/orders/bonus-refund', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://admin.oplatishka.com',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.readPanelActor.mockImplementation(async () => actor('operator'));
  h.getOrderDetail.mockImplementation(async () => orderWithBonus());
  h.release.mockImplementation(async () => ({
    applied: true,
    redemption: {
      orderId: 'order-1',
      userId: 'user-1',
      amountUsdCents: 354,
      discountKopecks: 28_600,
      rateKopecks: 810_000,
      status: 'released',
      releasedBy: STAFF_ID,
      reservedAt: new Date(),
      settledAt: new Date(),
    },
  }));
});

describe('POST /api/panel/orders/bonus-refund', () => {
  it('оператор возвращает баллы: возврат и событие — в ОДНОЙ транзакции, с автором', async () => {
    const res = await POST(request({ shortId: SHORT_ID }));
    const json = (await res.json()) as { ok: boolean; alreadyReleased: boolean };

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, alreadyReleased: false });
    expect(h.release).toHaveBeenCalledWith(
      h.txSentinel,
      { orderId: 'order-1', releasedBy: STAFF_ID },
      expect.anything(),
    );
    expect(h.appendEvent).toHaveBeenCalledWith(
      h.txSentinel,
      expect.objectContaining({
        eventType: 'bonus_released',
        actorType: 'operator',
        actorId: STAFF_ID,
        payload: expect.objectContaining({ reason: 'operator_refund', spendUsdCents: 354 }),
      }),
    );
  });

  it('клиенту уходит сообщение о возврате', async () => {
    await POST(request({ shortId: SHORT_ID }));

    expect(h.sendMessage).toHaveBeenCalledWith('777', expect.stringContaining('286'));
  });

  it('сорванная доставка сообщения возврат НЕ откатывает', async () => {
    h.sendMessage.mockRejectedValue(new Error('bot blocked'));

    const res = await POST(request({ shortId: SHORT_ID }));

    expect(res.status).toBe(200);
    expect(h.release).toHaveBeenCalled();
  });

  it('повтор идемпотентен: второй раз баллы не возвращаются и события нет', async () => {
    h.release.mockImplementation(async () => ({ applied: false, redemption: null }));

    const res = await POST(request({ shortId: SHORT_ID }));
    const json = (await res.json()) as { ok: boolean; alreadyReleased: boolean };

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, alreadyReleased: true });
    expect(h.appendEvent).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('заказ без списания — понятный отказ, а не 500', async () => {
    h.getOrderDetail.mockImplementation(async () => orderWithBonus({ bonusStatus: null }));

    const res = await POST(request({ shortId: SHORT_ID }));
    const json = (await res.json()) as { error: string };

    expect(res.status).toBe(409);
    expect(json.error).toBe('no_bonus');
    expect(h.release).not.toHaveBeenCalled();
  });

  it('оплатимый заказ возврата не получает — он вернёт баллы САМ', async () => {
    // Кнопка живёт только там, где решение принадлежит человеку.
    h.getOrderDetail.mockImplementation(async () => orderWithBonus({ status: 'ready_for_payment' }));

    const res = await POST(request({ shortId: SHORT_ID }));

    expect(res.status).toBe(409);
    expect(h.release).not.toHaveBeenCalled();
  });

  it('оплаченный заказ ещё не разобран — возврат не проводится', async () => {
    h.getOrderDetail.mockImplementation(async () => orderWithBonus({ status: 'paid' }));

    expect((await POST(request({ shortId: SHORT_ID }))).status).toBe(409);
    expect(h.release).not.toHaveBeenCalled();
  });

  it('похороненный заказ с УСПЕШНЫМ платежом — возврат доступен', async () => {
    // `paid_after_terminal`: крон похоронил заказ, оплата пришла следом. Баллы
    // правилом не возвращаются (скидка по счёту дана), решает человек.
    h.getOrderDetail.mockImplementation(async () => orderWithBonus({ status: 'expired' }));

    expect((await POST(request({ shortId: SHORT_ID }))).status).toBe(200);
    expect(h.release).toHaveBeenCalled();
  });

  it('похороненный заказ БЕЗ оплаты возврата не получает — правило уже вернуло', async () => {
    h.getOrderDetail.mockImplementation(async () =>
      orderWithBonus({ status: 'expired', hasSucceededPayment: false }),
    );

    expect((await POST(request({ shortId: SHORT_ID }))).status).toBe(409);
    expect(h.release).not.toHaveBeenCalled();
  });

  it('несуществующий заказ — 404', async () => {
    h.getOrderDetail.mockImplementation(async () => null);

    expect((await POST(request({ shortId: SHORT_ID }))).status).toBe(404);
  });

  it('не вошедший получает 401 и ничего не возвращает', async () => {
    h.readPanelActor.mockImplementation(async () => null);

    expect((await POST(request({ shortId: SHORT_ID }))).status).toBe(401);
    expect(h.release).not.toHaveBeenCalled();
  });

  it('роль без прав получает 403', async () => {
    h.readPanelActor.mockImplementation(async () => actor('supervisor'));

    expect((await POST(request({ shortId: SHORT_ID }))).status).toBe(403);
    expect(h.release).not.toHaveBeenCalled();
  });

  it('чужой Origin отсекается до чтения сессии', async () => {
    const res = await POST(
      new Request('https://admin.oplatishka.com/api/panel/orders/bonus-refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ shortId: SHORT_ID }),
      }),
    );

    expect(res.status).toBe(403);
    expect(h.readPanelActor).not.toHaveBeenCalled();
  });
});
