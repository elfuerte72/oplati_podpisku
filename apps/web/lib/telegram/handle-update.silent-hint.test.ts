import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.APP_URL = 'https://example.com';
process.env.TELEGRAM_BOT_TOKEN = '123:test-token';

const h = vi.hoisted(() => ({
  trackMock: vi.fn(),
  sendMock: vi.fn(async () => true),
  appendMock: vi.fn(async () => undefined),
  pendingSupportMock: vi.fn(async () => false),
  startMock: vi.fn(async () => undefined),
  supportCommandMock: vi.fn(async () => undefined),
  agentMock: vi.fn(async () => undefined),
  claimOnceMock: vi.fn(async () => true),
  state: { botAiEnabled: false },
}));

vi.mock('@/lib/analytics/track', () => ({ trackServer: h.trackMock }));
vi.mock('@/lib/dedup', () => ({
  claimOnce: h.claimOnceMock,
  releaseClaim: vi.fn(async () => undefined),
}));

vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'BOT_AI_ENABLED') return h.state.botAiEnabled;
        if (prop === 'TELEGRAM_BOT_TOKEN') return '123:test-token';
        if (prop === 'REFERRAL_ENABLED') return false;
        return undefined;
      },
    },
  ),
}));

vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    configured: false,
    limit: 0,
    remaining: 0,
  })),
}));

vi.mock('./send', () => ({
  sendSafely: h.sendMock,
  showOrEdit: vi.fn(async () => undefined),
}));
vi.mock('./persist', () => ({
  persistInbound: vi.fn(async () => ({ userId: 'u1', conversationId: 'c1' })),
  readPendingMeta: vi.fn(async () => null),
  safeAppendMessage: h.appendMock,
}));
vi.mock('./agent-dialog', () => ({ runAgentDialog: h.agentMock }));
vi.mock('./bot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bot')>();
  return {
    ...actual,
    getBot: () => ({ api: { answerCallbackQuery: vi.fn(async () => {}) } }),
  };
});
vi.mock('./start-menu', () => ({ handleStartCommand: h.startMock }));
vi.mock('./support-flow', () => ({
  handleSupportCallback: vi.fn(async () => undefined),
  handleSupportCommand: h.supportCommandMock,
  tryHandlePendingSupport: h.pendingSupportMock,
}));
vi.mock('./catalog-callbacks', () => ({
  handleOrderActionCallback: vi.fn(async () => undefined),
  handleServiceSelected: vi.fn(async () => undefined),
  handleTierSelected: vi.fn(async () => undefined),
  showCatalogList: vi.fn(async () => undefined),
  tryHandlePendingAmount: vi.fn(async () => false),
}));
vi.mock('./vpn-flow', () => ({
  handleVpnCallback: vi.fn(async () => undefined),
  handleVpnRefreshCallback: vi.fn(async () => undefined),
}));

import { handleTelegramUpdate } from './handle-update';
import { __resetSilentHintMemory } from './silent-hint';
import { SILENT_MEDIA_HINT, SILENT_TEXT_HINT } from './templates';

let updateId = 1000;

function textUpdate(text: string, from = 379336096) {
  return {
    update_id: ++updateId,
    message: {
      message_id: 1,
      chat: { id: 555, type: 'private' as const },
      from: { id: from, is_bot: false, first_name: 'Тест' },
      text,
    },
  };
}

function photoUpdate(from = 379336096) {
  return {
    update_id: ++updateId,
    message: {
      message_id: 2,
      chat: { id: 555, type: 'private' as const },
      from: { id: from, is_bot: false, first_name: 'Тест' },
      photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }],
    },
  };
}

function sentTexts(): string[] {
  return h.sendMock.mock.calls.map((c) => String((c as unknown[])[1]));
}

/**
 * Тикет 09: при выключенном `BOT_AI_ENABLED` бот больше не молчит на свободный
 * текст и медиа. Человек, написавший «помогите», получает одну фразу и кнопку
 * «Поддержка» — обращение по-прежнему создаётся ТОЛЬКО нажатием (правило
 * владельца), подсказка его не создаёт.
 */
describe('подсказка вместо молчания (BOT_AI_ENABLED=false)', () => {
  beforeEach(() => {
    h.trackMock.mockClear();
    h.sendMock.mockClear();
    h.appendMock.mockClear();
    h.agentMock.mockClear();
    h.startMock.mockClear();
    h.supportCommandMock.mockClear();
    h.pendingSupportMock.mockClear();
    h.pendingSupportMock.mockImplementation(async () => false);
    h.claimOnceMock.mockImplementation(async () => true);
    h.sendMock.mockImplementation(async () => true);
    h.state.botAiEnabled = false;
    __resetSilentHintMemory();
  });

  it('свободный текст получает подсказку и кнопку поддержки', async () => {
    await handleTelegramUpdate(textUpdate('помогите'));

    expect(h.sendMock).toHaveBeenCalledTimes(1);
    const [chatId, text, , keyboard] = h.sendMock.mock.calls[0] as unknown[];
    expect(chatId).toBe(555);
    expect(text).toBe(SILENT_TEXT_HINT);
    // Кнопка ведёт в существующий callback `support` — второго входа в
    // поддержку не заводим.
    expect(JSON.stringify(keyboard)).toContain('support');
  });

  it('подсказка ложится в переписку — оператор увидит её в ленте обращения', async () => {
    await handleTelegramUpdate(textUpdate('помогите'));

    const roles = h.appendMock.mock.calls.map((c) => (c as unknown[])[1]);
    expect(roles).toContain('assistant');
  });

  it('событие потери сохраняется, но помечено как отвеченное подсказкой', async () => {
    await handleTelegramUpdate(textUpdate('помогите'));

    expect(h.trackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'bot_text_ignored',
        props: expect.objectContaining({ kind: 'text', hinted: true }),
      }),
    );
  });

  it('медиа получает СВОЙ ответ', async () => {
    await handleTelegramUpdate(photoUpdate());

    expect(sentTexts()).toEqual([SILENT_MEDIA_HINT]);
  });

  it('альбом из десяти фото даёт одну подсказку', async () => {
    for (let i = 0; i < 10; i++) await handleTelegramUpdate(photoUpdate());

    expect(h.sendMock).toHaveBeenCalledTimes(1);
  });

  it('несколько сообщений подряд не превращаются в поток подсказок', async () => {
    await handleTelegramUpdate(textUpdate('помогите'));
    await handleTelegramUpdate(textUpdate('ну пожалуйста'));
    await handleTelegramUpdate(textUpdate('алло'));

    expect(h.sendMock).toHaveBeenCalledTimes(1);
  });

  it('недоставленная подсказка не запирает окно — следующее сообщение получит её', async () => {
    // `sendSafely` не бросает по контракту (webhook обязан ответить 200), и без
    // признака доставки claim расходовался бы на сообщение, которого клиент не
    // видел: час тишины ровно там, где тикет её и убирал.
    h.sendMock.mockImplementation(async () => false);
    await handleTelegramUpdate(textUpdate('помогите'));
    expect(h.sendMock).toHaveBeenCalledTimes(1);

    h.sendMock.mockImplementation(async () => true);
    await handleTelegramUpdate(textUpdate('ну пожалуйста'));

    expect(h.sendMock).toHaveBeenCalledTimes(2);
  });

  it('недоставленная подсказка не пишется в переписку', async () => {
    h.sendMock.mockImplementation(async () => false);

    await handleTelegramUpdate(textUpdate('помогите'));

    const roles = h.appendMock.mock.calls.map((c) => (c as unknown[])[1]);
    expect(roles).not.toContain('assistant');
  });

  it('разные пользователи получают подсказку каждый', async () => {
    await handleTelegramUpdate(textUpdate('помогите', 111));
    await handleTelegramUpdate(textUpdate('помогите', 222));

    expect(h.sendMock).toHaveBeenCalledTimes(2);
  });

  it('/start не трогается — идёт в своё меню без подсказки', async () => {
    await handleTelegramUpdate(textUpdate('/start link_abc'));

    expect(h.startMock).toHaveBeenCalledTimes(1);
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('/support не трогается', async () => {
    await handleTelegramUpdate(textUpdate('/support всё сломалось'));

    expect(h.supportCommandMock).toHaveBeenCalledTimes(1);
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('ожидание текста после кнопки «Поддержка» не перебивается подсказкой', async () => {
    h.pendingSupportMock.mockImplementation(async () => true);

    await handleTelegramUpdate(textUpdate('у меня не проходит оплата'));

    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('callback-кнопка подсказку не вызывает', async () => {
    await handleTelegramUpdate({
      update_id: ++updateId,
      callback_query: {
        id: 'cb1',
        from: { id: 379336096, is_bot: false, first_name: 'Тест' },
        chat_instance: 'ci',
        data: 'vpn',
        message: { message_id: 3, chat: { id: 555, type: 'private' as const } },
      },
    });

    expect(h.sendMock).not.toHaveBeenCalled();
  });
});

describe('при включённом AI путь прежний', () => {
  beforeEach(() => {
    h.sendMock.mockClear();
    h.agentMock.mockClear();
    h.state.botAiEnabled = true;
    __resetSilentHintMemory();
  });

  it('свободный текст уходит в агента, подсказки нет', async () => {
    await handleTelegramUpdate(textUpdate('хочу оплатить spotify'));

    expect(h.agentMock).toHaveBeenCalledTimes(1);
    expect(sentTexts()).not.toContain(SILENT_TEXT_HINT);
  });

  it('медиа отвечает прежним шаблоном, а не подсказкой', async () => {
    await handleTelegramUpdate(photoUpdate());

    expect(sentTexts()).not.toContain(SILENT_MEDIA_HINT);
    expect(h.sendMock).toHaveBeenCalledTimes(1);
  });
});
