import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Выгрузка списка заказов (панель v3).
 *
 * Проверяется не «красиво ли выглядит файл», а то, из-за чего выгрузке нельзя
 * будет верить: гейт запроса, передача фильтров экрана, устойчивый порядок
 * страниц, потолок и честная отметка об усечении.
 */

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
  listOrders: vi.fn<(...args: unknown[]) => Promise<{ items: unknown[]; hasMore: boolean }>>(
    async () => ({ items: [], hasMore: false }),
  ),
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
  return { ...actual, getDb: () => ({}) as unknown, listOrdersForPanel: h.listOrders };
});

import { EXPORT_MAX_ROWS, EXPORT_PAGE_SIZE } from '@/lib/panel/export';

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

function orderRow(shortId: string) {
  return {
    id: shortId,
    shortId,
    status: 'completed' as const,
    amountRubKopecks: 367200,
    createdAt: new Date('2026-09-02T14:34:00Z'),
    expiresAt: null,
    serviceName: 'HeyGen',
    client: { id: 'u1', displayName: 'Алинка', telegramId: '77', email: 'a@b.c' },
    assignedOperatorName: null,
  };
}

function request(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  const body = new URLSearchParams(fields);
  return new Request('https://admin.oplatishka.com/api/panel/export/orders', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://admin.oplatishka.com',
      ...headers,
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.readPanelActor.mockResolvedValue(actor('operator'));
  h.listOrders.mockResolvedValue({ items: [], hasMore: false });
});

describe('POST /api/panel/export/orders', () => {
  it('чужой Origin получает отказ и в базу не попадает', async () => {
    const res = await POST(request({}, { origin: 'https://www.oplatishka.com' }));

    expect(res.status).toBe(403);
    expect(h.listOrders).not.toHaveBeenCalled();
  });

  it('роль без права на заказы получает 403', async () => {
    h.readPanelActor.mockResolvedValue(actor('supervisor'));

    const res = await POST(request({}));

    expect(res.status).toBe(403);
    expect(h.listOrders).not.toHaveBeenCalled();
  });

  it('отдаёт файл с заголовком и без кэширования', async () => {
    h.listOrders.mockResolvedValue({ items: [orderRow('ORD-WX7S4')], hasMore: false });

    const res = await POST(request({}));
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    const text = await res.text();

    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    // Файл несёт контакты клиентов — ни прокси, ни браузер его не хранят.
    expect(res.headers.get('cache-control')).toBe('no-store');
    // ⚠️ BOM проверяется БАЙТАМИ: `Response.text()` по спецификации срезает его
    // при декодировании, и строковая проверка провалилась бы на рабочем файле.
    // В браузер уходят именно байты — иначе Excel даёт кракозябры.
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text).toContain('ORD-WX7S4');
    expect(text).toContain('3672,00');
  });

  it('фильтры и период экрана доезжают до выборки', async () => {
    await POST(request({ q: 'алина', s: 'unpaid', sort: 'amount_desc', period: '7' }));

    const call = h.listOrders.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(call.query).toBe('алина');
    expect(Array.isArray(call.statuses)).toBe(true);
    expect(call.createdFrom).toBeInstanceOf(Date);
    expect(call.createdTo).toBeInstanceOf(Date);
  });

  it('порядок выгрузки — от старых к новым, что бы ни стояло на экране', async () => {
    // Постраничное чтение идёт вне транзакции: при «сначала новые» заказ,
    // созданный во время выгрузки, сдвигает окно и дублирует строку на стыке.
    await POST(request({ sort: 'amount_desc' }));

    const call = h.listOrders.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(call.sort).toBe('oldest');
  });

  it('читает страницами, пока база говорит «есть ещё»', async () => {
    h.listOrders
      .mockResolvedValueOnce({ items: [orderRow('ORD-1')], hasMore: true })
      .mockResolvedValueOnce({ items: [orderRow('ORD-2')], hasMore: false });

    const text = await (await POST(request({}))).text();

    expect(h.listOrders).toHaveBeenCalledTimes(2);
    const secondCall = h.listOrders.mock.calls[1]?.[1] as Record<string, unknown>;
    // Шаг offset обязан совпадать с размером страницы, иначе выгрузка молча
    // теряет строки.
    expect(secondCall.offset).toBe(EXPORT_PAGE_SIZE);
    expect(secondCall.limit).toBe(EXPORT_PAGE_SIZE);
    expect(text).toContain('ORD-1');
    expect(text).toContain('ORD-2');
  });

  it('на потолке останавливается и говорит об усечении вслух', async () => {
    // База всегда отвечает «есть ещё» — цикл обязан кончиться сам.
    h.listOrders.mockResolvedValue({ items: [orderRow('ORD-X')], hasMore: true });

    const text = await (await POST(request({}))).text();

    expect(h.listOrders).toHaveBeenCalledTimes(EXPORT_MAX_ROWS / EXPORT_PAGE_SIZE);
    // Файл ровно на потолке неотличим от полного — отметка обязательна.
    expect(text).toContain(`Показаны первые ${EXPORT_MAX_ROWS} строк`);
  });

  it('полная выгрузка отметки об усечении не несёт', async () => {
    h.listOrders.mockResolvedValue({ items: [orderRow('ORD-1')], hasMore: false });

    const text = await (await POST(request({}))).text();

    expect(text).not.toContain('Показаны первые');
  });
});
