import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.APP_URL = 'https://example.com';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';

const setTelegramUsername = vi.hoisted(() => vi.fn());

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as never,
  setTelegramUsername,
}));

// `after()` вне запроса Next бросает — модуль обязан переживать это и писать
// синхронно, иначе результат сверки терялся бы в тестах и в кроне.
vi.mock('next/server', () => ({
  after: () => {
    throw new Error('after() called outside a request scope');
  },
}));

import { ensureClientTelegramUsername, USERNAME_RECHECK_AFTER_MS } from './client-username.ts';

const NOW = new Date('2026-09-09T07:00:00.000Z');

function chatResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  setTelegramUsername.mockClear();
  setTelegramUsername.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('сверка @username клиента с Telegram', () => {
  it('никогда не сверяли — спрашиваем Telegram и запоминаем ответ', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(chatResponse({ ok: true, result: { id: 1, username: 'nigora_n' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureClientTelegramUsername(
      {
        userId: 'u1',
        telegramId: '8069374561',
        telegramUsername: null,
        telegramUsernameCheckedAt: null,
      },
      NOW,
    );

    expect(result).toBe('nigora_n');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(setTelegramUsername).toHaveBeenCalledWith({}, { userId: 'u1', username: 'nigora_n' });
  });

  /*
   * Ради этого случая и заведена отметка о сверке: у клиента username нет
   * вовсе, ответ Telegram пустой — и без памятки карточка ходила бы в Bot API
   * на каждое открытие.
   */
  it('username нет — пустой результат тоже записывается', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(chatResponse({ ok: true, result: { id: 1, first_name: 'Ni' } })),
    );

    const result = await ensureClientTelegramUsername(
      { userId: 'u1', telegramId: '42', telegramUsername: null, telegramUsernameCheckedAt: null },
      NOW,
    );

    expect(result).toBeNull();
    expect(setTelegramUsername).toHaveBeenCalledWith({}, { userId: 'u1', username: null });
  });

  it('сверяли недавно — в Telegram не ходим', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureClientTelegramUsername(
      {
        userId: 'u1',
        telegramId: '42',
        telegramUsername: 'nemo',
        telegramUsernameCheckedAt: new Date(NOW.getTime() - 60_000),
      },
      NOW,
    );

    expect(result).toBe('nemo');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setTelegramUsername).not.toHaveBeenCalled();
  });

  it('отметка протухла — сверяем снова и обновляем', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(chatResponse({ ok: true, result: { username: 'new_name' } })),
    );

    const result = await ensureClientTelegramUsername(
      {
        userId: 'u1',
        telegramId: '42',
        telegramUsername: 'old_name',
        telegramUsernameCheckedAt: new Date(NOW.getTime() - USERNAME_RECHECK_AFTER_MS - 1),
      },
      NOW,
    );

    expect(result).toBe('new_name');
    expect(setTelegramUsername).toHaveBeenCalledWith({}, { userId: 'u1', username: 'new_name' });
  });

  /*
   * Отказ Telegram — не факт «username нет»: записать пустоту значило бы
   * погасить рабочую ссылку на неделю по чужой аварии.
   */
  it('Telegram не ответил — показываем известное и ничего не пишем', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse({ ok: false }, 400)));

    const result = await ensureClientTelegramUsername(
      {
        userId: 'u1',
        telegramId: '42',
        telegramUsername: 'known',
        telegramUsernameCheckedAt: null,
      },
      NOW,
    );

    expect(result).toBe('known');
    expect(setTelegramUsername).not.toHaveBeenCalled();
  });

  it('сеть отвалилась — тот же исход, экран не падает', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const result = await ensureClientTelegramUsername(
      { userId: 'u1', telegramId: '42', telegramUsername: null, telegramUsernameCheckedAt: null },
      NOW,
    );

    expect(result).toBeNull();
    expect(setTelegramUsername).not.toHaveBeenCalled();
  });

  it('клиент без Telegram — запроса нет вовсе', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureClientTelegramUsername(
      { userId: 'u1', telegramId: null, telegramUsername: null, telegramUsernameCheckedAt: null },
      NOW,
    );

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('мусор из ответа Telegram ссылкой не станет', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(chatResponse({ ok: true, result: { username: 'evil/path' } })),
    );

    const result = await ensureClientTelegramUsername(
      { userId: 'u1', telegramId: '42', telegramUsername: null, telegramUsernameCheckedAt: null },
      NOW,
    );

    expect(result).toBeNull();
    expect(setTelegramUsername).toHaveBeenCalledWith({}, { userId: 'u1', username: null });
  });
});
