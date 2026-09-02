import { GrammyError } from 'grammy';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Тест-отправка текста воронки себе в Telegram (тикет 12) — через шов бота
 * (подменный `api.sendMessage`): без клавиатуры, образцовые подстановки,
 * 403 → bot_blocked, нет telegram_id → no_telegram, невалидный текст не
 * уходит, кап по сотруднику.
 */

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
  sendMessage: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({})),
  rateLimit: vi.fn(async () => ({ allowed: true, configured: true, limit: 10, remaining: 9 })),
  captureException: vi.fn(),
}));

vi.mock('@/lib/panel/session', () => ({ readPanelActor: h.readPanelActor }));
vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'PANEL_HOST') return 'admin.oplatishka.com';
        if (prop === 'REFERRAL_MINIAPP_DEEPLINK') return false;
        return undefined;
      },
    },
  ),
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'admin.oplatishka.com' }),
}));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  listFunnelTextOverrides: vi.fn(async () => []),
}));
vi.mock('@/lib/telegram/bot', () => ({
  getBot: () => ({ api: { sendMessage: h.sendMessage } }),
  getBotUsername: vi.fn(async () => 'oplatishkaa_bot'),
}));
vi.mock('@/lib/ratelimit', () => ({ checkRateLimit: h.rateLimit }));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException, captureMessage: vi.fn() }));

import { POST } from './route.ts';

const STAFF_ID = '00000000-0000-4000-8000-0000000000ff';

function actor(over: { role?: 'admin' | 'operator'; telegramId?: string | null } = {}) {
  return {
    id: STAFF_ID,
    email: 'o@example.com',
    displayName: 'Владелец',
    role: over.role ?? 'admin',
    telegramId: over.telegramId === undefined ? '379336096' : over.telegramId,
    lastLoginAt: null,
  };
}

function request(body: unknown): Request {
  return new Request('https://admin.oplatishka.com/api/panel/texts/test-send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://admin.oplatishka.com' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.readPanelActor.mockReset();
  h.readPanelActor.mockImplementation(async () => actor());
  h.sendMessage.mockReset();
  h.sendMessage.mockImplementation(async () => ({}));
  h.rateLimit.mockClear();
  h.rateLimit.mockImplementation(async () => ({ allowed: true, configured: true, limit: 10, remaining: 9 }));
  h.captureException.mockClear();
});

describe('POST /api/panel/texts/test-send', () => {
  it('уходит клиентским ботом на telegram_id актора БЕЗ клавиатуры, {service} = Netflix', async () => {
    const res = await POST(request({ key: 'order_rating.body', value: 'Оцените {service}!' }));

    expect(res.status).toBe(200);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, extra] = h.sendMessage.mock.calls[0] ?? [];
    expect(chatId).toBe('379336096');
    expect(text).toBe('Оцените Netflix!');
    // Кнопки fb:* от сотрудника писали бы client_feedback ему как клиенту.
    expect(extra).toBeUndefined();
  });

  it('{link} — deep-link клиентского бота с ref_TEST тем же билдером, что в кабинете', async () => {
    await POST(request({ key: 'referral_nudge.body', value: 'Ссылка: {link}' }));
    const text = String(h.sendMessage.mock.calls[0]?.[1]);
    expect(text).toContain('oplatishkaa_bot');
    expect(text).toContain('ref_TEST');
  });

  it('подпись кнопки уходит текстом с пометкой «Кнопка:»', async () => {
    await POST(request({ key: 'common.optout_button', value: 'Хватит' }));
    expect(h.sendMessage.mock.calls[0]?.[1]).toBe('Кнопка: Хватит');
  });

  it('невалидный текст → 422, sendMessage не зван', async () => {
    const res = await POST(request({ key: 'referral_nudge.body', value: 'без ссылки' }));
    expect(res.status).toBe(422);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('нет telegram_id у сотрудника → 409 no_telegram', async () => {
    h.readPanelActor.mockImplementation(async () => actor({ telegramId: null }));
    const res = await POST(request({ key: 'common.thanks', value: 'Спасибо' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_telegram' });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('Telegram 403 (бот не запущен) → 409 bot_blocked без Sentry', async () => {
    h.sendMessage.mockImplementation(async () => {
      throw new GrammyError('Forbidden', { ok: false, error_code: 403, description: 'bot was blocked' }, 'sendMessage', {});
    });
    const res = await POST(request({ key: 'common.thanks', value: 'Спасибо' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'bot_blocked' });
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('прочий сбой Telegram → 502 + Sentry', async () => {
    h.sendMessage.mockImplementation(async () => {
      throw new Error('network');
    });
    const res = await POST(request({ key: 'common.thanks', value: 'Спасибо' }));
    expect(res.status).toBe(502);
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('кап panel-texts-test по сотруднику → 429 до валидации и отправки', async () => {
    h.rateLimit.mockImplementation(async () => ({ allowed: false, configured: true, limit: 10, remaining: 0 }));
    const res = await POST(request({ key: 'common.thanks', value: 'Спасибо' }));
    expect(res.status).toBe(429);
    expect(h.rateLimit).toHaveBeenCalledWith('panel-texts-test', STAFF_ID);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('оператор → 403', async () => {
    h.readPanelActor.mockImplementation(async () => actor({ role: 'operator' }));
    expect((await POST(request({ key: 'common.thanks', value: 'Спасибо' }))).status).toBe(403);
  });
});
