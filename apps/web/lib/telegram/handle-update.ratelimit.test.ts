import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.TELEGRAM_BOT_TOKEN = '123:test-token';

const h = vi.hoisted(() => ({
  checkRateLimit: vi.fn(async (name: string) => ({
    allowed:
      name === 'telegram-start'
        ? h.state.startAllowed
        : name === 'telegram-media'
          ? h.state.mediaAllowed
          : h.state.chatAllowed,
    configured: true,
    limit: 20,
    remaining: 0,
  })),
  startMock: vi.fn(async () => undefined),
  supportMock: vi.fn(async () => undefined),
  supportCallbackMock: vi.fn(async () => undefined),
  catalogMock: vi.fn(async () => undefined),
  sendMock: vi.fn(async (..._args: unknown[]) => undefined),
  trackMock: vi.fn(),
  state: { startAllowed: true, chatAllowed: true, mediaAllowed: true, botAiEnabled: false },
}));

vi.mock('@/lib/analytics/track', () => ({ trackServer: h.trackMock }));

vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'BOT_AI_ENABLED') return h.state.botAiEnabled;
        if (prop === 'REFERRAL_ENABLED') return false;
        return undefined;
      },
    },
  ),
}));

vi.mock('@/lib/ratelimit', () => ({ checkRateLimit: h.checkRateLimit }));

vi.mock('./send', () => ({
  sendSafely: h.sendMock,
  showOrEdit: vi.fn(async () => undefined),
}));
vi.mock('./persist', () => ({
  persistInbound: vi.fn(async () => null),
  readPendingMeta: vi.fn(async () => null),
  safeAppendMessage: vi.fn(async () => undefined),
}));
vi.mock('./agent-dialog', () => ({ runAgentDialog: vi.fn(async () => undefined) }));
vi.mock('./bot', () => ({
  getBot: () => ({ api: { answerCallbackQuery: vi.fn(async () => {}) } }),
}));
vi.mock('./start-menu', () => ({ handleStartCommand: h.startMock }));
vi.mock('./support-flow', () => ({
  handleSupportCallback: h.supportCallbackMock,
  handleSupportCommand: h.supportMock,
  tryHandlePendingSupport: vi.fn(async () => false),
}));
vi.mock('./catalog-callbacks', () => ({
  handleOrderActionCallback: vi.fn(async () => undefined),
  handleServiceSelected: vi.fn(async () => undefined),
  handleTierSelected: vi.fn(async () => undefined),
  showCatalogList: h.catalogMock,
  tryHandlePendingAmount: vi.fn(async () => false),
}));
vi.mock('./vpn-flow', () => ({
  handleVpnCallback: vi.fn(async () => undefined),
  handleVpnRefreshCallback: vi.fn(async () => undefined),
}));

import { handleTelegramUpdate } from './handle-update';

function textUpdate(text: string, updateId = 100) {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      chat: { id: 555, type: 'private' as const },
      from: { id: 379336096, is_bot: false, first_name: 'Тест' },
      text,
    },
  };
}

function photoUpdate(updateId = 300) {
  return {
    update_id: updateId,
    message: {
      message_id: 2,
      chat: { id: 555, type: 'private' as const },
      from: { id: 379336096, is_bot: false, first_name: 'Тест' },
      photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }],
    },
  };
}

/**
 * Анти-абьюз бота (аудит 2026-08-10). До фикса `/start` (включая `ref_`/`link_`),
 * `/menu` и медиа шли МИМО per-identity лимита: неограниченные upsert'ы `users`,
 * `conversations` и записи диалога с одного `telegram_id`. Лимит на текст при
 * этом стоял — то есть обходился ровно тем, что дороже всего.
 *
 * Бакета ТРИ намеренно (ревью 2026-08-11): у каждого входа свой кошелёк, чтобы
 * один не морил другой голодом. `/start link_<token>` — обязательный шаг оплаты
 * для пришедшего с сайта; альбом скриншотов не должен закрывать кнопку
 * «Поддержка».
 */
describe('rate-limit бота покрывает все входящие пути', () => {
  beforeEach(() => {
    h.checkRateLimit.mockClear();
    h.startMock.mockClear();
    h.supportMock.mockClear();
    h.supportCallbackMock.mockClear();
    h.catalogMock.mockClear();
    h.sendMock.mockClear();
    h.trackMock.mockClear();
    h.state.startAllowed = true;
    h.state.chatAllowed = true;
    h.state.mediaAllowed = true;
    h.state.botAiEnabled = false;
  });

  it('/start проверяется СВОИМ бакетом', async () => {
    await handleTelegramUpdate(textUpdate('/start'));
    expect(h.checkRateLimit).toHaveBeenCalledWith('telegram-start', '379336096');
  });

  it('исчерпанный бакет чата НЕ блокирует /start link_<token>', async () => {
    // Главный смысл разделения: привязка — шаг оплаты (без telegram_id
    // confirm_order платёжную ссылку не выдаёт), её нельзя ронять чужим трафиком.
    h.state.chatAllowed = false;
    await handleTelegramUpdate(textUpdate('/start link_deadbeef'));
    expect(h.startMock).toHaveBeenCalledOnce();
  });

  it('исчерпанный бакет /start не пускает команду в обработчик', async () => {
    h.state.startAllowed = false;
    await handleTelegramUpdate(textUpdate('/start'));
    expect(h.startMock).not.toHaveBeenCalled();
  });

  it('исчерпанный бакет /start не пускает и ref_, и link_', async () => {
    h.state.startAllowed = false;
    await handleTelegramUpdate(textUpdate('/start ref_ABCDE'));
    await handleTelegramUpdate(textUpdate('/start link_deadbeef', 101));
    expect(h.startMock).not.toHaveBeenCalled();
  });

  it('исчерпанный лимит не открывает /menu', async () => {
    h.state.botAiEnabled = true;
    h.state.chatAllowed = false;
    await handleTelegramUpdate(textUpdate('/menu'));
    expect(h.catalogMock).not.toHaveBeenCalled();
  });

  it('медиа тратит СВОЙ бакет, а не общий с кнопками', async () => {
    // Альбом Telegram шлёт по апдейту на фото. В общем бакете десять
    // скриншотов «не проходит оплата» закрывали бы клиенту кнопку «Поддержка»
    // ровно тогда, когда она нужна (ревью 2026-08-11).
    h.state.botAiEnabled = true;
    await handleTelegramUpdate(photoUpdate());
    expect(h.checkRateLimit).toHaveBeenCalledWith('telegram-media', '379336096');
  });

  it('исчерпанный бакет медиа не трогает текстовый путь', async () => {
    h.state.botAiEnabled = true;
    h.state.mediaAllowed = false;
    await handleTelegramUpdate(photoUpdate());
    await handleTelegramUpdate(textUpdate('/support помоги', 301));
    expect(h.supportMock).toHaveBeenCalledOnce();
  });

  it('сверх лимита на медиа бот молчит', async () => {
    // Окрик на каждое фото альбома = десять одинаковых сообщений; плюс это
    // ломало бы контракт «на медиа молчим» при выключенном BOT_AI_ENABLED.
    h.state.botAiEnabled = true;
    h.state.mediaAllowed = false;
    await handleTelegramUpdate(photoUpdate());
    expect(h.sendMock).not.toHaveBeenCalled();
    expect(h.trackMock).not.toHaveBeenCalled();
  });

  it('нажатие inline-кнопки лимитируется бакетом чата', async () => {
    await handleTelegramUpdate({
      update_id: 400,
      callback_query: {
        id: 'cb1',
        from: { id: 379336096, is_bot: false, first_name: 'Тест' },
        chat_instance: 'ci',
        data: 'support',
        message: { message_id: 3, chat: { id: 555, type: 'private' as const } },
      },
    });
    expect(h.checkRateLimit).toHaveBeenCalledWith('telegram', '379336096');
  });

  it('исчерпанный бакет чата не пускает кнопку в обработчик', async () => {
    h.state.chatAllowed = false;
    await handleTelegramUpdate({
      update_id: 401,
      callback_query: {
        id: 'cb2',
        from: { id: 379336096, is_bot: false, first_name: 'Тест' },
        chat_instance: 'ci',
        data: 'support',
        message: { message_id: 4, chat: { id: 555, type: 'private' as const } },
      },
    });
    expect(h.supportCallbackMock).not.toHaveBeenCalled();
  });

  it('на текст сверх лимита бот отвечает, а не молчит', async () => {
    h.state.chatAllowed = false;
    await handleTelegramUpdate(textUpdate('привет'));
    expect(h.sendMock).toHaveBeenCalledOnce();
    expect(String(h.sendMock.mock.calls[0]?.[1] ?? '')).toContain('Слишком много');
  });

  it('исчерпанный лимит не пускает /support', async () => {
    h.state.chatAllowed = false;
    await handleTelegramUpdate(textUpdate('/support всё сломалось'));
    expect(h.supportMock).not.toHaveBeenCalled();
  });

  it('лимит проверяется РОВНО один раз на апдейт', async () => {
    // Двойной вызов удваивал бы расход бакета и резал живых пользователей вдвое
    // раньше срока.
    await handleTelegramUpdate(textUpdate('/support помоги'));
    expect(h.checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it('при разрешённом лимите пути работают как прежде', async () => {
    h.state.botAiEnabled = true;
    await handleTelegramUpdate(textUpdate('/start'));
    await handleTelegramUpdate(textUpdate('/menu', 101));
    await handleTelegramUpdate(textUpdate('/support ой', 102));
    expect(h.startMock).toHaveBeenCalledOnce();
    expect(h.catalogMock).toHaveBeenCalledOnce();
    expect(h.supportMock).toHaveBeenCalledOnce();
  });

  it('апдейт без message лимит не тратит', async () => {
    await handleTelegramUpdate({ update_id: 999 });
    expect(h.checkRateLimit).not.toHaveBeenCalled();
  });
});
