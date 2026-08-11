import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.INTERNAL_API_TOKEN = 'test-internal-token';

const h = vi.hoisted(() => ({
  insertMock: vi.fn(async (_db: unknown, rows: unknown[]) => rows.length),
  state: {
    webSessionId: 'sess-1' as string | null,
    telegramId: null as string | null,
    rateLimitAllowed: true,
  },
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  insertAnalyticsEvents: h.insertMock,
}));

vi.mock('@/lib/chat/session', () => ({
  readWebSessionId: vi.fn(async () => h.state.webSessionId),
}));

vi.mock('@/lib/analytics/miniapp-identity', () => ({
  readTelegramIdFromInitData: vi.fn(() => h.state.telegramId),
}));

vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: h.state.rateLimitAllowed,
    configured: true,
    limit: 30,
    remaining: 29,
  })),
  getClientIp: vi.fn(() => '1.2.3.4'),
}));

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: (fn: () => void) => fn() };
});

import { POST } from './route';

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/analytics', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function event(over: Record<string, unknown> = {}) {
  return {
    eventKey: `key-${Math.random().toString(36).slice(2)}0000000`,
    name: 'catalog_open',
    channel: 'web',
    occurredAt: new Date().toISOString(),
    ...over,
  };
}

describe('POST /api/analytics', () => {
  beforeEach(() => {
    h.insertMock.mockClear();
    h.state.webSessionId = 'sess-1';
    h.state.telegramId = null;
    h.state.rateLimitAllowed = true;
  });

  it('принимает батч и пишет события', async () => {
    const res = await POST(makeRequest({ events: [event(), event({ name: 'service_click' })] }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, accepted: 2 });
    expect(h.insertMock).toHaveBeenCalledOnce();
  });

  it('rate-limit срабатывает ДО записи в БД (инвариант 9)', async () => {
    h.state.rateLimitAllowed = false;
    const res = await POST(makeRequest({ events: [event()] }));
    expect(res.status).toBe(429);
    expect(h.insertMock).not.toHaveBeenCalled();
  });

  it('батч из одних серверных имён не пишет ничего', async () => {
    // Иначе оплаты и конверсию можно было бы нарисовать curl'ом.
    const res = await POST(makeRequest({ events: [event({ name: 'bot_start' })] }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, accepted: 0 });
    expect(h.insertMock).not.toHaveBeenCalled();
  });

  it('серверное имя не попадает в БД, соседнее клиентское — попадает', async () => {
    const res = await POST(
      makeRequest({ events: [event({ name: 'bot_text_ignored' }), event()] }),
    );
    expect(res.status).toBe(200);
    const rows = h.insertMock.mock.calls[0]?.[1] as { name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('catalog_open');
  });

  it('identity берётся с сервера, а не из тела запроса', async () => {
    h.state.webSessionId = 'cookie-session';
    const res = await POST(
      makeRequest({
        events: [event({ webSessionId: 'подделка', telegramId: '999' })],
      }),
    );
    expect(res.status).toBe(200);
    const rows = h.insertMock.mock.calls[0]?.[1] as {
      webSessionId: string | null;
      telegramId: string | null;
    }[];
    expect(rows[0]?.webSessionId).toBe('cookie-session');
    expect(rows[0]?.telegramId).toBeNull();
  });

  it('telegram_id приезжает только из подписанной initData', async () => {
    h.state.webSessionId = null;
    h.state.telegramId = '379336096';
    const res = await POST(
      makeRequest({ events: [event({ channel: 'miniapp', name: 'cabinet_open' })] }, {
        'x-telegram-init-data': 'query_id=AAA&user=%7B%22id%22%3A379336096%7D&hash=deadbeef',
      }),
    );
    expect(res.status).toBe(200);
    const rows = h.insertMock.mock.calls[0]?.[1] as { telegramId: string | null }[];
    expect(rows[0]?.telegramId).toBe('379336096');
  });

  it('клиентский channel=miniapp без подписи понижается до web', async () => {
    // Иначе любой curl с cookie сайта дописывает себе события «из Mini App» —
    // роут заявляет в собственной шапке, что личности из тела не доверяет,
    // а канал брал именно оттуда (аудит 2026-08-10).
    h.state.webSessionId = 'sess-1';
    h.state.telegramId = null;
    await POST(makeRequest({ events: [event({ channel: 'miniapp' })] }));
    const rows = h.insertMock.mock.calls[0]?.[1] as { channel: string }[];
    expect(rows[0]?.channel).toBe('web');
  });

  it('channel=miniapp принимается при валидной initData', async () => {
    h.state.webSessionId = null;
    h.state.telegramId = '379336096';
    await POST(
      makeRequest({ events: [event({ channel: 'miniapp' })] }, {
        'x-telegram-init-data': 'query_id=AAA&user=%7B%22id%22%3A379336096%7D&hash=deadbeef',
      }),
    );
    const rows = h.insertMock.mock.calls[0]?.[1] as { channel: string }[];
    expect(rows[0]?.channel).toBe('miniapp');
  });

  it('собственный канал события подписью не подменяется', async () => {
    // `cabinet_open` живёт в Mini App по словарю — клиентское `web` его не сносит.
    h.state.webSessionId = null;
    h.state.telegramId = '379336096';
    await POST(
      makeRequest({ events: [event({ name: 'cabinet_open', channel: 'web' })] }, {
        'x-telegram-init-data': 'query_id=AAA&user=%7B%22id%22%3A379336096%7D&hash=deadbeef',
      }),
    );
    const rows = h.insertMock.mock.calls[0]?.[1] as { channel: string }[];
    expect(rows[0]?.channel).toBe('miniapp');
  });

  it('без identity ничего не пишет, но и не ругается', async () => {
    h.state.webSessionId = null;
    h.state.telegramId = null;
    const res = await POST(makeRequest({ events: [event()] }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, accepted: 0 });
    expect(h.insertMock).not.toHaveBeenCalled();
  });

  it('время из будущего заменяется серверным', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await POST(makeRequest({ events: [event({ occurredAt: future })] }));
    const rows = h.insertMock.mock.calls[0]?.[1] as { occurredAt: Date }[];
    expect(rows[0]!.occurredAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('чужие ключи props отбрасываются, свои остаются', async () => {
    await POST(
      makeRequest({
        events: [event({ props: { slug: 'spotify', email: 'a@b.c', pan: '4111111111111111' } })],
      }),
    );
    const rows = h.insertMock.mock.calls[0]?.[1] as { props: Record<string, unknown> }[];
    expect(rows[0]?.props).toEqual({ slug: 'spotify' });
  });

  it('битый JSON и не-батч — 400 без записи', async () => {
    expect((await POST(makeRequest('не json'))).status).toBe(400);
    expect((await POST(makeRequest({ events: [] }))).status).toBe(400);
    expect((await POST(makeRequest({ nope: 1 }))).status).toBe(400);
    expect(h.insertMock).not.toHaveBeenCalled();
  });

  it('одно битое событие не роняет соседние в том же батче', async () => {
    // Закэшированный старый клиент с устаревшим именем не должен уносить с
    // собой валидные события (находка ревью 2026-07-30).
    const res = await POST(
      makeRequest({
        events: [
          event({ name: 'catalogOpened' }),
          event({ occurredAt: 'не дата' }),
          event({ orderRef: '11111111-1111-4111-8111-111111111111' }),
          event(),
        ],
      }),
    );

    expect(res.status).toBe(200);
    const rows = h.insertMock.mock.calls[0]?.[1] as { name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('catalog_open');
  });

  it('номер заказа доезжает в props как order_ref', async () => {
    await POST(makeRequest({ events: [event({ orderRef: 'ORD-K2M4A' })] }));
    const rows = h.insertMock.mock.calls[0]?.[1] as { props: Record<string, unknown> }[];
    expect(rows[0]?.props).toMatchObject({ order_ref: 'ORD-K2M4A' });
  });

  it('недоступная БД не роняет запрос', async () => {
    // Телеметрия — наблюдатель: её отказ не должен превращаться в ошибку у клиента.
    h.insertMock.mockRejectedValueOnce(new Error('db is down'));
    const res = await POST(makeRequest({ events: [event()] }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, accepted: 0 });
  });
});
