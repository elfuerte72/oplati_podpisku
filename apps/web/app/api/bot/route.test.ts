import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

const SECRET = 'webhook-secret-value';

const h = vi.hoisted(() => ({
  handle: vi.fn(async () => undefined),
  claimOnce: vi.fn(async (_key: string, _ttl?: number) => true),
  extendClaim: vi.fn(async (..._args: unknown[]) => undefined),
  captureException: vi.fn(),
  state: { botToken: '123456:AAA' as string | undefined, anthropicKey: 'sk-test' as string | undefined },
}));

vi.mock('@/lib/telegram/handle-update', () => ({ handleTelegramUpdate: h.handle }));
vi.mock('@/lib/dedup', () => ({ claimOnce: h.claimOnce, extendClaim: h.extendClaim }));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException }));
vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'TELEGRAM_WEBHOOK_SECRET') return SECRET;
        if (prop === 'TELEGRAM_BOT_TOKEN') return h.state.botToken;
        if (prop === 'ANTHROPIC_API_KEY') return h.state.anthropicKey;
        return undefined;
      },
    },
  ),
}));

import { POST } from './route';

function makeRequest(body: unknown, secret: string | null = SECRET): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers['x-telegram-bot-api-secret-token'] = secret;
  return new Request('https://example.com/api/bot', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function update(updateId = 500) {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      chat: { id: 555, type: 'private' },
      from: { id: 379336096, is_bot: false, first_name: 'Тест' },
      text: '/start',
    },
  };
}

describe('POST /api/bot', () => {
  beforeEach(() => {
    h.handle.mockClear();
    h.claimOnce.mockClear();
    h.claimOnce.mockResolvedValue(true);
    h.extendClaim.mockClear();
    h.captureException.mockClear();
    h.state.botToken = '123456:AAA';
    h.state.anthropicKey = 'sk-test';
  });

  it('неверный secret-token → 401 и обработчик не зван', async () => {
    const res = await POST(makeRequest(update(), 'wrong-secret'));
    expect(res.status).toBe(401);
    expect(h.handle).not.toHaveBeenCalled();
  });

  it('отсутствие secret-token → 401', async () => {
    const res = await POST(makeRequest(update(), null));
    expect(res.status).toBe(401);
    expect(h.handle).not.toHaveBeenCalled();
  });

  it('битый JSON → 200 skipped (иначе Telegram забьёт очередь ретраями)', async () => {
    const res = await POST(makeRequest('не json'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, skipped: 'invalid_json' });
    expect(h.handle).not.toHaveBeenCalled();
  });

  it('апдейт не по контракту → 200 skipped', async () => {
    const res = await POST(makeRequest({ nope: 1 }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ skipped: 'invalid_update' });
    expect(h.handle).not.toHaveBeenCalled();
  });

  it('обработчик бросил → всё равно 200', async () => {
    h.handle.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(makeRequest(update()));
    expect(res.status).toBe(200);
    expect(h.captureException).toHaveBeenCalled();
  });

  it('незаданный TELEGRAM_BOT_TOKEN выключает бота', async () => {
    h.state.botToken = undefined;
    const res = await POST(makeRequest(update()));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ skipped: 'not_configured' });
    expect(h.handle).not.toHaveBeenCalled();
  });
});

/**
 * Telegram переДОСТАВЛЯЕТ апдейт, если не получил 200 вовремя, а наш обработчик
 * синхронный и живёт до 90 с. Без дедупа повтор проходил весь путь заново:
 * второе сообщение клиенту, второй счёт по кнопке `confirm`, второй вызов
 * панели VPN, а при включённом AI — второй платный ход агента (аудит 2026-08-10).
 */
describe('дедуп update_id', () => {
  beforeEach(() => {
    h.handle.mockClear();
    h.claimOnce.mockClear();
    h.extendClaim.mockClear();
    h.claimOnce.mockResolvedValue(true);
    h.state.botToken = '123456:AAA';
  });

  it('повторная доставка того же update_id не зовёт обработчик дважды', async () => {
    h.claimOnce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await POST(makeRequest(update(777)));
    const res = await POST(makeRequest(update(777)));

    expect(h.handle).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ skipped: 'duplicate' });
  });

  it('ключ дедупа включает id бота — два бота не гасят апдейты друг друга', async () => {
    await POST(makeRequest(update(777)));
    const key = h.claimOnce.mock.calls[0]?.[0] as string;
    expect(key).toContain('123456');
    expect(key).toContain('777');
  });

  it('дедуп берётся ДО обработчика, а не после', async () => {
    await POST(makeRequest(update(779)));
    expect(h.claimOnce.mock.invocationCallOrder[0]!).toBeLessThan(
      h.handle.mock.invocationCallOrder[0]!,
    );
  });

  it('ключ берётся на короткий срок, а продлевается только после обработки', async () => {
    // Смысл двух фаз: умерший процесс ключ не освободит, и длинный TTL с самого
    // начала превратил бы ретрай Telegram — единственный путь восстановления —
    // в тихую потерю апдейта (ревью 2026-08-11).
    await POST(makeRequest(update(780)));
    const claimTtl = h.claimOnce.mock.calls[0]?.[1] as number;
    const extendTtl = h.extendClaim.mock.calls[0]?.[1] as number;
    expect(claimTtl).toBeLessThan(extendTtl);
    expect(h.extendClaim.mock.invocationCallOrder[0]!).toBeGreaterThan(
      h.handle.mock.invocationCallOrder[0]!,
    );
  });

  it('дубль не продлевает чужой ключ', async () => {
    h.claimOnce.mockResolvedValueOnce(false);
    await POST(makeRequest(update(781)));
    expect(h.extendClaim).not.toHaveBeenCalled();
  });

  it('упавший обработчик всё равно продлевает ключ (ретрая не будет — мы ответили 200)', async () => {
    h.handle.mockRejectedValueOnce(new Error('boom'));
    await POST(makeRequest(update(782)));
    expect(h.extendClaim).toHaveBeenCalledTimes(1);
  });
});

/**
 * Отсутствие `ANTHROPIC_API_KEY` молча выключало ВЕСЬ бот, включая
 * платёжно-критичные не-AI флоу (`/start`, меню, оплата, VPN) — при том что
 * AI-диалог и так за флагом `BOT_AI_ENABLED` (на проде выключен). Гейт по ключу
 * обязан закрывать только AI-путь (аудит 2026-08-10).
 */
describe('бот без ключа Anthropic', () => {
  beforeEach(() => {
    h.handle.mockClear();
    h.claimOnce.mockClear();
    h.claimOnce.mockResolvedValue(true);
    h.state.botToken = '123456:AAA';
    h.state.anthropicKey = undefined;
  });

  it('кнопочные и платёжные флоу продолжают работать', async () => {
    const res = await POST(makeRequest(update()));
    expect(res.status).toBe(200);
    expect(h.handle).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.not.toMatchObject({ skipped: 'not_configured' });
  });
});
