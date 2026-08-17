import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ручное исполнение заказа (тикет 06) — денежный путь: заказ, выданный руками,
 * возвращается в выручку.
 *
 * Что здесь держится:
 *   - право `fulfillment` есть у менеджера НАМЕРЕННО, но не у роли без прав;
 *   - комментарий обязателен на первом шаге (журнал без причины бесполезен);
 *   - переход идёт ТОЛЬКО через `transitionOrder*`, с автором и комментарием;
 *   - чужой статус — понятный отказ, а не исключение из глубины.
 */

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
  getOrderDetail: vi.fn(),
  transition: vi.fn(),
  captureException: vi.fn(),
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
    getOrderDetailForPanel: h.getOrderDetail,
    transitionOrderDetailed: h.transition,
  };
});

vi.mock('@sentry/nextjs', () => ({
  captureException: h.captureException,
  captureMessage: vi.fn(),
}));

import { OrderTransitionError } from '@oplati/types';

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

function orderIn(status: string, hasSucceededPayment = true) {
  return { hasSucceededPayment, order: { id: 'order-1', shortId: SHORT_ID, status } };
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://admin.oplatishka.com/api/panel/orders/fulfillment', {
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
  h.getOrderDetail.mockReset();
  h.transition.mockReset();
  h.captureException.mockClear();
  h.readPanelActor.mockImplementation(async () => actor('operator'));
  h.getOrderDetail.mockImplementation(async () => orderIn('failed'));
  h.transition.mockImplementation(async () => ({
    order: { status: 'in_fulfillment' },
    transitioned: true,
  }));
});

describe('POST /api/panel/orders/fulfillment — права', () => {
  it('менеджер выполняет ручную выдачу: надзор вместо запрета', async () => {
    const res = await POST(
      request({ shortId: SHORT_ID, action: 'start', comment: 'реквизиты отправили вручную' }),
    );

    expect(res.status).toBe(200);
    expect(h.transition).toHaveBeenCalled();
  });

  it('не вошедший получает 401', async () => {
    h.readPanelActor.mockImplementation(async () => null);

    const res = await POST(request({ shortId: SHORT_ID, action: 'start', comment: 'а' .repeat(20) }));

    expect(res.status).toBe(401);
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('роль без прав не проводит операцию даже прямым запросом', async () => {
    h.readPanelActor.mockImplementation(async () => actor('supervisor'));

    const res = await POST(
      request({ shortId: SHORT_ID, action: 'start', comment: 'выдал руками, всё хорошо' }),
    );

    expect(res.status).toBe(403);
    expect(h.transition).not.toHaveBeenCalled();
  });
});

describe('POST /api/panel/orders/fulfillment — комментарий', () => {
  it('первый шаг без комментария отклоняется', async () => {
    const res = await POST(request({ shortId: SHORT_ID, action: 'start' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'comment_required' });
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('отписка из двух букв не считается комментарием', async () => {
    const res = await POST(request({ shortId: SHORT_ID, action: 'start', comment: 'ок' }));

    expect(res.status).toBe(400);
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('комментарий и автор попадают в журнал', async () => {
    await POST(
      request({ shortId: SHORT_ID, action: 'start', comment: 'реквизиты отправили вручную' }),
    );

    expect(h.transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toStatus: 'in_fulfillment',
        actorType: 'operator',
        actorId: STAFF_ID,
        eventType: 'manual_fulfillment_started',
        payload: expect.objectContaining({ comment: 'реквизиты отправили вручную' }),
      }),
      expect.anything(),
    );
  });

  it('второй шаг комментария не требует — причина уже записана', async () => {
    h.getOrderDetail.mockImplementation(async () => orderIn('in_fulfillment'));
    h.transition.mockImplementation(async () => ({
      order: { status: 'completed' },
      transitioned: true,
    }));

    const res = await POST(request({ shortId: SHORT_ID, action: 'complete' }));

    expect(res.status).toBe(200);
    expect(h.transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'completed', eventType: 'manual_fulfillment_completed' }),
      expect.anything(),
    );
  });
});

describe('POST /api/panel/orders/fulfillment — деньги', () => {
  it('заказ БЕЗ успешного платежа вручную выдать нельзя', async () => {
    // `failed` — не синоним «деньги получены»: сюда же попадает заказ, счёт по
    // которому провайдер отверг, и недоплата. Отметить такой выданным значило
    // бы записать в выручку деньги, которых нет.
    h.getOrderDetail.mockImplementation(async () => orderIn('failed', false));

    const res = await POST(
      request({ shortId: SHORT_ID, action: 'start', comment: 'выдал руками, всё хорошо' }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_paid' });
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('номер карты в комментарии маскируется — журнал append-only навсегда', async () => {
    await POST(
      request({
        shortId: SHORT_ID,
        action: 'start',
        comment: 'пополнил карту 4111 1111 1111 1111 и отправил реквизиты',
      }),
    );

    const payload = h.transition.mock.calls[0]?.[1]?.payload as { comment?: string };
    expect(payload.comment).not.toContain('4111 1111 1111 1111');
    expect(payload.comment).toContain('1111');
  });
});

describe('POST /api/panel/orders/fulfillment — CSRF', () => {
  it('запрос с чужого origin отвергается ДО чтения сессии', async () => {
    // `sameSite=lax` тут не защищает: www и admin — один site, cookie уедет.
    const res = await POST(
      request(
        { shortId: SHORT_ID, action: 'start', comment: 'выдал руками, всё хорошо' },
        { origin: 'https://www.oplatishka.com' },
      ),
    );

    expect(res.status).toBe(403);
    expect(h.readPanelActor).not.toHaveBeenCalled();
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('запрос без origin отвергается — браузер его всегда ставит', async () => {
    const req = new Request('https://admin.oplatishka.com/api/panel/orders/fulfillment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shortId: SHORT_ID, action: 'complete' }),
    });

    expect((await POST(req)).status).toBe(403);
  });

  it('«простой» content-type отвергается — иначе форма обходит preflight', async () => {
    const req = new Request('https://admin.oplatishka.com/api/panel/orders/fulfillment', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://admin.oplatishka.com' },
      body: JSON.stringify({ shortId: SHORT_ID, action: 'complete' }),
    });

    expect((await POST(req)).status).toBe(403);
    expect(h.transition).not.toHaveBeenCalled();
  });
});

describe('POST /api/panel/orders/fulfillment — статусы и сбои', () => {
  it('заказ не в том статусе — понятный отказ, а не исключение', async () => {
    h.getOrderDetail.mockImplementation(async () => orderIn('completed'));

    const res = await POST(
      request({ shortId: SHORT_ID, action: 'start', comment: 'выдал руками, всё хорошо' }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'wrong_status', expected: 'failed' });
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('«выдал» на провалившемся заказе не проходит — шаги нельзя перепрыгнуть', async () => {
    h.getOrderDetail.mockImplementation(async () => orderIn('failed'));

    const res = await POST(request({ shortId: SHORT_ID, action: 'complete' }));

    expect(res.status).toBe(409);
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('заказ увели параллельно — 409, а не 500', async () => {
    h.transition.mockImplementation(async () => {
      throw new OrderTransitionError('order-1', 'failed', 'in_fulfillment');
    });

    const res = await POST(
      request({ shortId: SHORT_ID, action: 'start', comment: 'выдал руками, всё хорошо' }),
    );

    expect(res.status).toBe(409);
  });

  it('несуществующий заказ — 404', async () => {
    h.getOrderDetail.mockImplementation(async () => null);

    const res = await POST(
      request({ shortId: SHORT_ID, action: 'start', comment: 'выдал руками, всё хорошо' }),
    );

    expect(res.status).toBe(404);
  });

  it('мусорный номер заказа отвергается до похода в базу', async () => {
    const res = await POST(
      request({ shortId: 'нет-такого', action: 'start', comment: 'выдал руками, всё хорошо' }),
    );

    expect(res.status).toBe(400);
    expect(h.getOrderDetail).not.toHaveBeenCalled();
  });

  it('сбой базы — 503 и запись в Sentry, а не тишина', async () => {
    h.transition.mockImplementation(async () => {
      throw new Error('db down');
    });

    const res = await POST(
      request({ shortId: SHORT_ID, action: 'start', comment: 'выдал руками, всё хорошо' }),
    );

    expect(res.status).toBe(503);
    expect(h.captureException).toHaveBeenCalled();
  });
});
