import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv + конфиг relay'а.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.SENTRY_ALERT_WEBHOOK_SECRET = 'top-secret';
process.env.ALERT_TELEGRAM_CHAT_ID = '111222333';

const h = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  // Лимитер мокаем явно: без Upstash он fail-open, и тесты «проверяли» бы
  // поведение, которого нет — упасть они не могли ни при какой поломке.
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, configured: true, limit: 10, remaining: 9 })),
}));

vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => h.checkRateLimitMock(...(args as [])),
  getClientIp: () => '203.0.113.7',
}));

vi.mock('@/lib/telegram/bot', () => ({
  getBot: () => ({ api: { sendMessage: h.sendMessageMock } }),
}));

import { POST } from './route.ts';

const SAMPLE = {
  project_name: 'oplati-web',
  level: 'error',
  url: 'https://sentry.io/issues/123/',
  event: { title: 'PaySpaceApiError: insufficient funds', environment: 'production' },
};

function makeReq(query: string, body: unknown): Request {
  return new Request(`https://example.com/api/alerts/sentry${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/alerts/sentry', () => {
  beforeEach(() => {
    h.sendMessageMock.mockReset();
    h.checkRateLimitMock.mockClear();
  });

  it('валидный секрет → 200 + пересылка в Telegram', async () => {
    const res = await POST(makeReq('?s=top-secret', SAMPLE));
    expect(res.status).toBe(200);
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
    const [chatId, text] = h.sendMessageMock.mock.calls[0]!;
    expect(chatId).toBe('111222333');
    expect(text).toContain('PaySpaceApiError: insufficient funds');
  });

  it('РЕГРЕСС 2026-08-16: боевой payload internal integration доезжает с содержанием', async () => {
    // Прод шлёт именно эту форму (интеграция telegram-alerts-d8df3a в правиле
    // 644412), а тесты знали только legacy — поэтому владельцу месяцами
    // приходило «Sentry issue / Проект: — / Окружение: —» и выглядело как шум.
    const res = await POST(
      makeReq('?s=top-secret', {
        action: 'triggered',
        installation: { uuid: 'a8e5d37a' },
        data: {
          event: {
            title: 'FreekassaApiError: Request with same (or bigger) nonce already exist',
            culprit: 'GET /api/cron/poll-payment',
            level: 'error',
            tags: [['environment', 'production']],
            web_url: 'https://oplatishka.sentry.io/issues/1117540176/',
          },
          triggered_rule: 'Send a notification for high priority issues',
        },
      }),
    );

    expect(res.status).toBe(200);
    const [, text] = h.sendMessageMock.mock.calls[0] as [string, string];
    expect(text).toContain('FreekassaApiError');
    expect(text).toContain('Где: GET /api/cron/poll-payment');
    expect(text).toContain('Окружение: production');
    expect(text).toContain('https://oplatishka.sentry.io/issues/1117540176/');
  });

  it('секрет в заголовке X-Alert-Token тоже принимается', async () => {
    const req = new Request('https://example.com/api/alerts/sentry', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alert-token': 'top-secret' },
      body: JSON.stringify(SAMPLE),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('неверный секрет → 401, без отправки', async () => {
    const res = await POST(makeReq('?s=wrong', SAMPLE));
    expect(res.status).toBe(401);
    expect(h.sendMessageMock).not.toHaveBeenCalled();
  });

  it('без секрета → 401, без отправки', async () => {
    const res = await POST(makeReq('', SAMPLE));
    expect(res.status).toBe(401);
    expect(h.sendMessageMock).not.toHaveBeenCalled();
  });

  it('невалидный payload (не-объект) → 200 skipped, без отправки', async () => {
    const res = await POST(makeReq('?s=top-secret', 'oops'));
    expect(res.status).toBe(200);
    expect(h.sendMessageMock).not.toHaveBeenCalled();
  });

  it('падение Telegram не валит endpoint (200) и не зовёт Sentry', async () => {
    h.sendMessageMock.mockRejectedValueOnce(new Error('tg down'));
    const res = await POST(makeReq('?s=top-secret', SAMPLE));
    expect(res.status).toBe(200);
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
  });
  it('успешные алёрты НЕ лимитируются — лимитер на этом пути не зовётся вовсе', async () => {
    // Молча отброшенное уведомление хуже отсутствующего: шторм алёртов
    // случается ровно тогда, когда всё горит. Проверяем не «ответ 200» (он был
    // бы 200 и при fail-open лимитере), а что лимитер тут вообще не участвует.
    for (let i = 0; i < 25; i++) {
      const res = await POST(makeReq('?s=top-secret', SAMPLE));
      expect(res.status).toBe(200);
    }
    expect(h.sendMessageMock).toHaveBeenCalledTimes(25);
    expect(h.checkRateLimitMock).not.toHaveBeenCalled();
  });

  it('неудачная попытка считается лимитером по IP', async () => {
    const res = await POST(makeReq('?s=wrong', SAMPLE));

    expect(res.status).toBe(401);
    expect(h.checkRateLimitMock).toHaveBeenCalledWith('alert-webhook-auth', '203.0.113.7');
    expect(h.sendMessageMock).not.toHaveBeenCalled();
  });

  it('лимит исчерпан → 429 вместо 401, алёрт не пересылается', async () => {
    h.checkRateLimitMock.mockResolvedValueOnce({
      allowed: false,
      configured: true,
      limit: 10,
      remaining: 0,
    });

    const res = await POST(makeReq('?s=wrong', SAMPLE));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ error: 'rate_limited' });
    expect(h.sendMessageMock).not.toHaveBeenCalled();
  });
});
