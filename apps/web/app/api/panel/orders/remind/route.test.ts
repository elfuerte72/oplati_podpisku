import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Напоминание об оплате (тикет 07) — денежный путь: клиенту уходит ссылка на
 * СУЩЕСТВУЮЩИЙ живой счёт.
 *
 * Что здесь держится:
 *   - ничего не создаётся: операция читает тот же список, что и экран;
 *   - дедуп «не чаще раза в сутки», и отметка ставится ПОСЛЕ отправки;
 *   - клиенту без Telegram и по протухшему счёту — отказ, а не пустая отправка;
 *   - сорванная доставка не выдаётся за успех и не выжигает суточное окно.
 */

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
  listPending: vi.fn(),
  appendEvent: vi.fn(async (..._args: unknown[]) => {}),
  claimReminder: vi.fn(async (..._args: unknown[]) => true),
  transitionOrder: vi.fn(async () => ({})),
  upsertPayment: vi.fn(async () => ({})),
  setOrderExpiresAt: vi.fn(async () => {}),
  sendMessage: vi.fn(async (..._args: unknown[]) => {}),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
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

vi.mock('@oplati/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oplati/db')>();
  return {
    ...actual,
    getDb: () => ({}) as unknown,
    listPendingOrdersForPanel: h.listPending,
    appendOrderEvent: h.appendEvent,
    claimPaymentReminder: h.claimReminder,
    // Шпионы на мутирующие пути: инвариант тикета «операция НИЧЕГО не
    // создаёт» иначе держится только списком импортов роута.
    transitionOrder: h.transitionOrder,
    transitionOrderDetailed: h.transitionOrder,
    upsertPaymentByProviderRef: h.upsertPayment,
    setOrderExpiresAt: h.setOrderExpiresAt,
  };
});

vi.mock('@/lib/telegram/bot', () => ({
  getBot: () => ({ api: { sendMessage: h.sendMessage } }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: h.captureException,
  captureMessage: h.captureMessage,
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

function pendingOrder(over: Record<string, unknown> = {}) {
  return {
    orderId: 'order-1',
    shortId: SHORT_ID,
    status: 'pending_payment',
    amountRubKopecks: 50_000,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 60_000),
    serviceName: 'Netflix',
    client: { id: 'user-1', displayName: 'Клиент', telegramId: '555' },
    invoice: {
      paymentId: 'pay-1',
      expiresAt: new Date(Date.now() + 30 * 60_000),
      paymentUrl: 'https://pay.freekassa.ru/form/1',
    },
    lastRemindedAt: null,
    ...over,
  };
}

/** Как ведёт себя выборка с фильтром `shortId`. */
function matchingItems(items: ReturnType<typeof pendingOrder>[], opts: unknown) {
  const shortId = (opts as { shortId?: string } | undefined)?.shortId;
  return {
    items: shortId ? items.filter((i) => i.shortId.toUpperCase() === shortId.toUpperCase()) : items,
    hasMore: false,
  };
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://admin.oplatishka.com/api/panel/orders/remind', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://admin.oplatishka.com',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.readPanelActor.mockReset();
  h.listPending.mockReset();
  h.appendEvent.mockReset();
  h.claimReminder.mockReset();
  h.transitionOrder.mockReset();
  h.upsertPayment.mockReset();
  h.setOrderExpiresAt.mockReset();
  h.sendMessage.mockReset();
  h.captureException.mockClear();
  h.captureMessage.mockClear();
  h.readPanelActor.mockImplementation(async () => actor('operator'));
  // Мок УВАЖАЕТ фильтр по номеру: операция сужает выборку до одного заказа, и
  // мок, отдающий строку на любой номер, скрыл бы это от теста.
  h.listPending.mockImplementation(async (..._args: unknown[]) =>
    matchingItems([pendingOrder()], _args[1]),
  );
  h.appendEvent.mockImplementation(async () => {});
  h.claimReminder.mockImplementation(async () => true);
  h.sendMessage.mockImplementation(async () => {});
});

describe('POST /api/panel/orders/remind — доступ', () => {
  it('менеджер напоминает: раздел его', async () => {
    const res = await POST(request({ shortId: SHORT_ID }));

    expect(res.status).toBe(200);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('не вошедший получает 401 и ничего не отправляет', async () => {
    h.readPanelActor.mockImplementation(async () => null);

    const res = await POST(request({ shortId: SHORT_ID }));

    expect(res.status).toBe(401);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('роль без прав не проводит операцию прямым запросом', async () => {
    h.readPanelActor.mockImplementation(async () => actor('supervisor'));

    const res = await POST(request({ shortId: SHORT_ID }));

    expect(res.status).toBe(403);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('чужой Origin не проходит: между www и admin cookie уезжает', async () => {
    const res = await POST(
      request({ shortId: SHORT_ID }, { origin: 'https://www.oplatishka.com' }),
    );

    expect(res.status).toBe(403);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});

describe('POST /api/panel/orders/remind — правила', () => {
  it('в сообщении уходит ссылка существующего счёта, а не новый счёт', async () => {
    await POST(request({ shortId: SHORT_ID }));

    const [chatId, text] = h.sendMessage.mock.calls[0] as unknown as [string, string];
    expect(chatId).toBe('555');
    expect(text).toContain('https://pay.freekassa.ru/form/1');
    expect(text).toContain(SHORT_ID);
  });

  it('окно суток занимается АТОМАРНО и до отправки', async () => {
    // Схема «прочитали отметку → отправили → записали» атомарной не является:
    // две вкладки проходят гейт одновременно, и клиент получает два одинаковых
    // платёжных документа от официального бота.
    await POST(request({ shortId: SHORT_ID }));

    expect(h.claimReminder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderId: 'order-1', actorId: STAFF_ID }),
    );
    const claimOrder = h.claimReminder.mock.invocationCallOrder[0] ?? 0;
    const sendOrder = h.sendMessage.mock.invocationCallOrder[0] ?? 0;
    expect(claimOrder).toBeLessThan(sendOrder);
  });

  it('проигравший гонку не отправляет ничего', async () => {
    h.claimReminder.mockImplementation(async () => false);

    const res = await POST(request({ shortId: SHORT_ID }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'too_soon' });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('операция НИЧЕГО не создаёт и не двигает', async () => {
    // Инвариант тикета: кнопка отправляет ссылку существующего счёта. Второй
    // способ выпускать денежные документы мимо гейтов `payments/create` тут
    // появиться не должен ни сейчас, ни правкой через полгода.
    await POST(request({ shortId: SHORT_ID }));

    expect(h.transitionOrder).not.toHaveBeenCalled();
    expect(h.upsertPayment).not.toHaveBeenCalled();
    expect(h.setOrderExpiresAt).not.toHaveBeenCalled();
  });

  it('второе напоминание за сутки отвергается ещё на гейте', async () => {
    h.listPending.mockImplementation(async (..._args: unknown[]) =>
      matchingItems([pendingOrder({ lastRemindedAt: new Date(Date.now() - 60 * 60_000) })], _args[1]),
    );

    const res = await POST(request({ shortId: SHORT_ID }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'too_soon' });
    expect(h.claimReminder).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('протухший счёт: заказ ещё «ждёт оплаты», а ссылка уже мертва', async () => {
    // Крон хоронит заказы раз в 15 минут — окно расхождения реальное.
    h.listPending.mockImplementation(async (..._args: unknown[]) =>
      matchingItems([pendingOrder({
          invoice: {
            paymentId: 'pay-1',
            expiresAt: new Date(Date.now() - 60_000),
            paymentUrl: 'https://pay.freekassa.ru/form/1',
          },
        })], _args[1]),
    );

    const res = await POST(request({ shortId: SHORT_ID }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'invoice_expired' });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('черновик без счёта: отправлять нечего', async () => {
    h.listPending.mockImplementation(async (..._args: unknown[]) =>
      matchingItems([pendingOrder({ status: 'ready_for_payment', invoice: null })], _args[1]),
    );

    const res = await POST(request({ shortId: SHORT_ID }));

    expect(res.status).toBe(409);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('клиенту без Telegram не отправляем ничего', async () => {
    h.listPending.mockImplementation(async (..._args: unknown[]) =>
      matchingItems([pendingOrder({ client: { id: 'user-1', displayName: 'Веб', telegramId: null } })], _args[1]),
    );

    const res = await POST(request({ shortId: SHORT_ID }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_telegram' });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('испорченная ссылка в снимке инвойса клиенту не уходит', async () => {
    h.listPending.mockImplementation(async (..._args: unknown[]) =>
      matchingItems([pendingOrder({
          invoice: {
            paymentId: 'pay-1',
            expiresAt: new Date(Date.now() + 30 * 60_000),
            paymentUrl: 'javascript:alert(1)',
          },
        })], _args[1]),
    );

    const res = await POST(request({ shortId: SHORT_ID }));

    expect(res.status).toBe(409);
    expect(h.sendMessage).not.toHaveBeenCalled();
    // Молчать нельзя: на экране такой заказ выглядит готовым к напоминанию.
    expect(h.captureMessage).toHaveBeenCalled();
  });

  it('сорванная отправка не выдаётся за успех и записывается фактом', async () => {
    h.sendMessage.mockImplementation(async () => {
      throw new Error('Forbidden: bot was blocked by the user');
    });

    const res = await POST(request({ shortId: SHORT_ID }));

    expect(res.status).toBe(502);
    // Окно уже занято и вернуть его нечем (журнал append-only), поэтому пишем
    // недоставку: иначе экран покажет «напоминали в 14:20» тому, кто ничего
    // не получил.
    expect(h.appendEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'payment_reminder_failed' }),
    );
  });

  it('потеря отметки о недоставке уходит в Sentry, а не теряется', async () => {
    h.sendMessage.mockImplementation(async () => {
      throw new Error('Forbidden: bot was blocked by the user');
    });
    h.appendEvent.mockImplementation(async () => {
      throw new Error('connection terminated');
    });

    const res = await POST(request({ shortId: SHORT_ID }));

    expect(res.status).toBe(502);
    expect(h.captureException).toHaveBeenCalled();
  });

  it('чужой номер заказа — 404, без единой отправки', async () => {
    const res = await POST(request({ shortId: 'ORD-AAAAA' }));

    expect(res.status).toBe(404);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('битое тело отвергается до чтения базы', async () => {
    const res = await POST(request({ shortId: 'не-номер' }));

    expect(res.status).toBe(400);
    expect(h.listPending).not.toHaveBeenCalled();
  });
});
