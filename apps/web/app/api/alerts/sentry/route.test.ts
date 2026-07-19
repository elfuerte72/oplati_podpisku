import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv + конфиг relay'а.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.SENTRY_ALERT_WEBHOOK_SECRET = 'top-secret';
process.env.ALERT_TELEGRAM_CHAT_ID = '111222333';

const h = vi.hoisted(() => ({ sendMessageMock: vi.fn() }));

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
  });

  it('валидный секрет → 200 + пересылка в Telegram', async () => {
    const res = await POST(makeReq('?s=top-secret', SAMPLE));
    expect(res.status).toBe(200);
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
    const [chatId, text] = h.sendMessageMock.mock.calls[0]!;
    expect(chatId).toBe('111222333');
    expect(text).toContain('PaySpaceApiError: insufficient funds');
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
});
