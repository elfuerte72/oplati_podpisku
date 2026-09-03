import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Быстрый поиск панели (v3): гейт запроса, права и порог длины.
 *
 * ⚠️ Главное здесь — не выдача, а то, ЧЕГО роут не делает: не отвечает чужому
 * сайту, не отвечает не вошедшему и не ходит в базу на один символ.
 */

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
  listOrders: vi.fn<(...args: unknown[]) => Promise<{ items: unknown[]; hasMore: boolean }>>(
    async () => ({ items: [], hasMore: false }),
  ),
  searchClients: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
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
    listOrdersForPanel: h.listOrders,
    searchClientsForPanel: h.searchClients,
  };
});

import { POST } from './route.ts';

function actor(role: 'admin' | 'operator' | 'supervisor') {
  return {
    id: '00000000-0000-4000-8000-0000000000ff',
    email: 'op@example.com',
    displayName: 'Менеджер',
    role,
    telegramId: '1',
    lastLoginAt: null,
  };
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://admin.oplatishka.com/api/panel/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://admin.oplatishka.com', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.readPanelActor.mockResolvedValue(actor('operator'));
  h.listOrders.mockResolvedValue({ items: [], hasMore: false });
  h.searchClients.mockResolvedValue([]);
});

describe('POST /api/panel/search', () => {
  it('чужой Origin получает отказ и в базу не попадает', async () => {
    const res = await POST(request({ query: 'алина' }, { origin: 'https://www.oplatishka.com' }));

    expect(res.status).toBe(403);
    expect(h.listOrders).not.toHaveBeenCalled();
    expect(h.searchClients).not.toHaveBeenCalled();
  });

  it('не вошедший получает 401', async () => {
    h.readPanelActor.mockResolvedValue(null);

    const res = await POST(request({ query: 'алина' }));

    expect(res.status).toBe(401);
    expect(h.listOrders).not.toHaveBeenCalled();
  });

  it('роль без права на заказы получает 403', async () => {
    h.readPanelActor.mockResolvedValue(actor('supervisor'));

    const res = await POST(request({ query: 'алина' }));

    expect(res.status).toBe(403);
    expect(h.searchClients).not.toHaveBeenCalled();
  });

  it('один символ отвечает пустотой, не тревожа базу', async () => {
    const res = await POST(request({ query: 'а' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, orders: [], clients: [] });
    expect(h.listOrders).not.toHaveBeenCalled();
    expect(h.searchClients).not.toHaveBeenCalled();
  });

  it('находит заказы и клиентов одним запросом', async () => {
    h.listOrders.mockResolvedValue({
      items: [
        {
          id: 'o1',
          shortId: 'ORD-WX7S4',
          status: 'completed',
          amountRubKopecks: 367200,
          createdAt: new Date(),
          expiresAt: null,
          serviceName: 'HeyGen',
          client: { id: 'u1', displayName: 'Алинка', telegramId: '77', email: null },
          assignedOperatorName: null,
        },
      ],
      hasMore: false,
    });
    h.searchClients.mockResolvedValue([
      { id: 'u1', displayName: 'Алинка', telegramId: '77', email: 'a@b.c', phone: '+79991234567' },
    ]);

    const res = await POST(request({ query: 'алин' }));
    const body = (await res.json()) as {
      orders: { shortId: string }[];
      clients: Record<string, unknown>[];
    };

    expect(res.status).toBe(200);
    expect(body.orders[0]?.shortId).toBe('ORD-WX7S4');
    expect(body.clients[0]).toMatchObject({ id: 'u1', displayName: 'Алинка' });
    // Телефон наружу не уходит: в выдаче он ничего не различает, а PII на
    // экране тем меньше, чем меньше её туда попало.
    expect(body.clients[0]).not.toHaveProperty('phone');
  });

  it('битое тело — 400, а не пятисотка', async () => {
    const res = await POST(request({ query: 42 }));

    expect(res.status).toBe(400);
  });
});
