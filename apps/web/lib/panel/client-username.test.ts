import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.APP_URL = 'https://example.com';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';

const setTelegramUsername = vi.hoisted(() => vi.fn());
const touchTelegramUsernameCheck = vi.hoisted(() => vi.fn());
const getChat = vi.hoisted(() => vi.fn());

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as never,
  setTelegramUsername,
  touchTelegramUsernameCheck,
}));

/*
 * Класс ошибки объявлен ЗДЕСЬ и подставлен в мок: код различает отказ Telegram
 * по существу через `instanceof`, значит тест обязан бросать ровно тот класс,
 * который модуль получит из мока. Конструктор настоящего `GrammyError` требует
 * четыре аргумента — повторять его форму ради двух полей незачем.
 */
const grammyErrorClass = vi.hoisted(
  () =>
    class GrammyError extends Error {
      error_code: number;
      constructor(code: number, description: string) {
        super(description);
        this.name = 'GrammyError';
        this.error_code = code;
      }
    },
);

vi.mock('grammy', () => {
  class Api {
    getChat = getChat;
  }
  return { Api, GrammyError: grammyErrorClass };
});

// `after()` вне запроса Next бросает — модуль обязан переживать это и писать
// синхронно, иначе результат сверки терялся бы в тестах и в кроне.
vi.mock('next/server', () => ({
  after: () => {
    throw new Error('after() called outside a request scope');
  },
}));

import {
  ensureClientTelegramUsername,
  resetClientUsernameApiForTests,
  USERNAME_RECHECK_AFTER_MS,
} from './client-username.ts';

const NOW = new Date('2026-09-09T07:00:00.000Z');

beforeEach(() => {
  setTelegramUsername.mockClear().mockResolvedValue(undefined);
  touchTelegramUsernameCheck.mockClear().mockResolvedValue(undefined);
  getChat.mockReset();
  resetClientUsernameApiForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('сверка @username клиента с Telegram', () => {
  it('никогда не сверяли — спрашиваем Telegram и запоминаем ответ', async () => {
    getChat.mockResolvedValue({ id: 1, username: 'nigora_n' });

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
    expect(getChat).toHaveBeenCalledOnce();
    expect(setTelegramUsername).toHaveBeenCalledWith({}, { userId: 'u1', username: 'nigora_n' });
  });

  /*
   * Ради этого случая и заведена отметка о сверке: у клиента username нет
   * вовсе, ответ Telegram пустой — и без памятки карточка ходила бы в Bot API
   * на каждое открытие, а страница панели обновляется сама раз в 25 секунд.
   */
  it('username нет — пустой результат тоже записывается', async () => {
    getChat.mockResolvedValue({ id: 1, first_name: 'Ni' });

    const result = await ensureClientTelegramUsername(
      { userId: 'u1', telegramId: '42', telegramUsername: null, telegramUsernameCheckedAt: null },
      NOW,
    );

    expect(result).toBeNull();
    expect(setTelegramUsername).toHaveBeenCalledWith({}, { userId: 'u1', username: null });
  });

  it('сверяли недавно — в Telegram не ходим', async () => {
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
    expect(getChat).not.toHaveBeenCalled();
    expect(setTelegramUsername).not.toHaveBeenCalled();
  });

  /*
   * Экран не должен ждать сеть ради подписи кнопки, которая и так будет
   * нарисована: известное имя показывается сразу, сверка идёт следом.
   */
  it('имя известно, но сверка протухла — показываем сразу и обновляем в фоне', async () => {
    getChat.mockResolvedValue({ username: 'new_name' });

    const result = await ensureClientTelegramUsername(
      {
        userId: 'u1',
        telegramId: '42',
        telegramUsername: 'old_name',
        telegramUsernameCheckedAt: new Date(NOW.getTime() - USERNAME_RECHECK_AFTER_MS - 1),
      },
      NOW,
    );

    expect(result).toBe('old_name');
    // Фоновая работа выполняется синхронным фолбэком `after()` — к этому моменту
    // она уже прошла.
    expect(setTelegramUsername).toHaveBeenCalledWith({}, { userId: 'u1', username: 'new_name' });
  });

  /*
   * Отказ Telegram по существу («чат недоступен боту») — не факт «username
   * сняли»: имя остаётся, но памятка ставится, иначе клиент с мёртвым
   * telegram_id добавляет два поводка к каждому открытию карточки навсегда.
   */
  it('Telegram отвечает 400 — имя не трогаем, но помечаем сверку', async () => {
    getChat.mockRejectedValue(new grammyErrorClass(400, 'Bad Request: chat not found'));

    const result = await ensureClientTelegramUsername(
      { userId: 'u1', telegramId: '42', telegramUsername: 'known', telegramUsernameCheckedAt: null },
      NOW,
    );

    expect(result).toBe('known');
    expect(setTelegramUsername).not.toHaveBeenCalled();
    expect(touchTelegramUsernameCheck).toHaveBeenCalledWith({}, { userId: 'u1' });
  });

  /*
   * А вот транспорт памятку НЕ ставит: записать её значило бы сутки не
   * пытаться снова из-за одного таймаута.
   */
  it('сеть отвалилась — не пишем ничего, экран не падает', async () => {
    getChat.mockRejectedValue(new TypeError('fetch failed'));

    const result = await ensureClientTelegramUsername(
      { userId: 'u1', telegramId: '42', telegramUsername: null, telegramUsernameCheckedAt: null },
      NOW,
    );

    expect(result).toBeNull();
    expect(setTelegramUsername).not.toHaveBeenCalled();
    expect(touchTelegramUsernameCheck).not.toHaveBeenCalled();
  });

  it('клиент без Telegram — запроса нет вовсе', async () => {
    const result = await ensureClientTelegramUsername(
      { userId: 'u1', telegramId: null, telegramUsername: null, telegramUsernameCheckedAt: null },
      NOW,
    );

    expect(result).toBeNull();
    expect(getChat).not.toHaveBeenCalled();
  });

  /*
   * Мусор в ответе — аномалия, а не «имя сменилось»: рабочую ссылку по нему не
   * гасим, иначе один странный ответ Telegram лишает оператора лички на сутки.
   */
  it('мусор из ответа Telegram не стирает известное имя', async () => {
    getChat.mockResolvedValue({ username: 'evil/path' });

    const result = await ensureClientTelegramUsername(
      { userId: 'u1', telegramId: '42', telegramUsername: 'known', telegramUsernameCheckedAt: null },
      NOW,
    );

    expect(result).toBe('known');
    expect(setTelegramUsername).not.toHaveBeenCalled();
    expect(touchTelegramUsernameCheck).toHaveBeenCalledWith({}, { userId: 'u1' });
  });

  it('без токена бота сверки нет — показываем известное', async () => {
    const saved = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = '';
    vi.resetModules();
    try {
      const { ensureClientTelegramUsername: fresh } = await import('./client-username.ts');
      const result = await fresh(
        { userId: 'u1', telegramId: '42', telegramUsername: 'known', telegramUsernameCheckedAt: null },
        NOW,
      );
      expect(result).toBe('known');
      expect(getChat).not.toHaveBeenCalled();
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = saved;
      vi.resetModules();
    }
  });
});
