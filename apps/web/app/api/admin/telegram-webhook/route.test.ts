import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Админский роут управления вебхуком бота: `X-Internal-Token` — единственный
 * барьер. За ним `setWebhook`/`deleteWebhook` боевого бота, то есть возможность
 * УВЕСТИ ВЕСЬ трафик бота на чужой адрес (вместе с платёжными callback'ами) или
 * оставить клиентов без бота вовсе. До аудита 2026-08-10 — ни одного
 * негативного теста.
 */

const h = vi.hoisted(() => ({
  setWebhook: vi.fn(async () => true),
  deleteWebhook: vi.fn(async () => true),
  getWebhookInfo: vi.fn(async () => ({ url: 'https://example.com/api/bot', pending_update_count: 0 })),
  setMyCommands: vi.fn(async () => true),
  env: {
    INTERNAL_API_TOKEN: 'internal-token-value' as string | undefined,
    TELEGRAM_WEBHOOK_SECRET: 'webhook-secret' as string | undefined,
  } as Record<string, unknown>,
}));

vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => h.env[key],
  }),
}));

vi.mock('@/lib/telegram/bot', () => ({
  getBot: () => ({
    api: {
      setWebhook: h.setWebhook,
      deleteWebhook: h.deleteWebhook,
      getWebhookInfo: h.getWebhookInfo,
      setMyCommands: h.setMyCommands,
    },
  }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { DELETE, GET, POST } from './route.ts';

const TOKEN = 'internal-token-value';
const URL_BODY = { url: 'https://new.oplatishka.com/api/bot' };

function makeRequest(
  method: 'GET' | 'POST' | 'DELETE',
  opts: { token?: string | null; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers['x-internal-token'] = token;
  if (method === 'POST') headers['content-type'] = 'application/json';
  return new Request('https://example.com/api/admin/telegram-webhook', {
    method,
    headers,
    ...(method === 'POST'
      ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body ?? URL_BODY) }
      : {}),
  });
}

beforeEach(() => {
  h.setWebhook.mockClear();
  h.deleteWebhook.mockClear();
  h.getWebhookInfo.mockClear();
  h.setMyCommands.mockClear();
  h.env.INTERNAL_API_TOKEN = TOKEN;
  h.env.TELEGRAM_WEBHOOK_SECRET = 'webhook-secret';
});

describe('X-Internal-Token — барьер на всех трёх методах', () => {
  it.each([
    ['GET', () => GET(makeRequest('GET', { token: null }))],
    ['POST', () => POST(makeRequest('POST', { token: null }))],
    ['DELETE', () => DELETE(makeRequest('DELETE', { token: null }))],
  ])('%s без токена → 401', async (_m, call) => {
    const res = await call();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it.each([
    ['GET', (t: string) => GET(makeRequest('GET', { token: t }))],
    ['POST', (t: string) => POST(makeRequest('POST', { token: t }))],
    ['DELETE', (t: string) => DELETE(makeRequest('DELETE', { token: t }))],
  ])('%s с чужим токеном → 401', async (_m, call) => {
    expect((await call('wrong-token')).status).toBe(401);
  });

  it('чужой токен не доходит до Telegram — вебхук не трогается', async () => {
    await POST(makeRequest('POST', { token: 'wrong-token' }));
    await DELETE(makeRequest('DELETE', { token: 'wrong-token' }));
    expect(h.setWebhook).not.toHaveBeenCalled();
    expect(h.deleteWebhook).not.toHaveBeenCalled();
  });

  it('префикс верного токена не проходит (сравнение не по началу строки)', async () => {
    expect((await GET(makeRequest('GET', { token: TOKEN.slice(0, -1) }))).status).toBe(401);
    expect((await GET(makeRequest('GET', { token: `${TOKEN}x` }))).status).toBe(401);
  });

  it('пустой токен в заголовке → 401', async () => {
    expect((await GET(makeRequest('GET', { token: '' }))).status).toBe(401);
  });

  it('НЕЗАДАННЫЙ INTERNAL_API_TOKEN закрывает роут, а не открывает его', async () => {
    // Fail-closed: иначе деплой с потерянной переменной отдал бы управление
    // вебхуком боевого бота любому желающему.
    h.env.INTERNAL_API_TOKEN = undefined;
    expect((await GET(makeRequest('GET', { token: '' }))).status).toBe(401);
    expect((await GET(makeRequest('GET', { token: null }))).status).toBe(401);
    expect((await POST(makeRequest('POST', { token: TOKEN }))).status).toBe(401);
  });
});

describe('POST — регистрация вебхука', () => {
  it('валидный запрос ставит вебхук с secret_token и нужными allowed_updates', async () => {
    const res = await POST(makeRequest('POST'));
    expect(res.status).toBe(200);
    expect(h.setWebhook).toHaveBeenCalledWith(
      URL_BODY.url,
      expect.objectContaining({
        secret_token: 'webhook-secret',
        drop_pending_updates: false,
        allowed_updates: ['message', 'callback_query'],
      }),
    );
  });

  it('не-URL в теле отклоняется до вызова Telegram', async () => {
    const res = await POST(makeRequest('POST', { body: { url: 'не-урл' } }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_body' });
    expect(h.setWebhook).not.toHaveBeenCalled();
  });

  it('битый JSON → 400, вебхук не трогается', async () => {
    const res = await POST(makeRequest('POST', { body: '{не json' }));
    expect(res.status).toBe(400);
    expect(h.setWebhook).not.toHaveBeenCalled();
  });

  it('без TELEGRAM_WEBHOOK_SECRET вебхук НЕ ставится (иначе бот стал бы открытым)', async () => {
    h.env.TELEGRAM_WEBHOOK_SECRET = undefined;
    const res = await POST(makeRequest('POST'));
    expect(res.status).toBe(500);
    expect(h.setWebhook).not.toHaveBeenCalled();
  });

  it('сбой setMyCommands не отменяет уже поставленный вебхук', async () => {
    h.setMyCommands.mockRejectedValueOnce(new Error('429 too many requests'));
    const res = await POST(makeRequest('POST'));
    expect(res.status).toBe(200);
    expect(h.setWebhook).toHaveBeenCalledTimes(1);
  });

  it('сбой setWebhook отдаётся 500, а не тихим ok', async () => {
    h.setWebhook.mockRejectedValueOnce(new Error('401 unauthorized bot token'));
    const res = await POST(makeRequest('POST'));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: 'internal_error' });
  });
});

describe('GET/DELETE', () => {
  it('GET отдаёт состояние вебхука', async () => {
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(h.getWebhookInfo).toHaveBeenCalled();
  });

  it('DELETE снимает вебхук', async () => {
    const res = await DELETE(makeRequest('DELETE'));
    expect(res.status).toBe(200);
    expect(h.deleteWebhook).toHaveBeenCalledWith({ drop_pending_updates: true });
  });
});
