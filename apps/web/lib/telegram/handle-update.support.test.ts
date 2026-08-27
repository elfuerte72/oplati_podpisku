import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.APP_URL = 'https://example.com';
process.env.TELEGRAM_BOT_TOKEN = '123:test-token';

/**
 * Второй шов — вход бота (спека «Testing Decisions» п. 2).
 *
 * Здесь проверяется ТОЛЬКО диспетчеризация: какая кнопка, команда и ссылка
 * ведут в модуль поддержки, что происходит при выключенном флаге и в режиме
 * `idle`. Поведение самого помощника живёт в `lib/support/session.test.ts` —
 * дублировать матрицу здесь значило бы чинить её в двух местах.
 */

const h = vi.hoisted(() => ({
  trackMock: vi.fn(),
  sendMock: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
  appendMock: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  startMock: vi.fn(async () => undefined),
  supportCommandMock: vi.fn(async () => undefined),
  supportCallbackMock: vi.fn(async () => undefined),
  // Типы моков заданы явно: `vi.fn(async () => ...)` выводит пустой кортеж
  // аргументов и союз из одного литерала, и тест перестаёт компилироваться,
  // как только проверяет реально переданный аргумент или другой исход.
  openSupportMock: vi.fn<(...args: unknown[]) => Promise<{ status: string }>>(async () => ({
    status: 'opened',
  })),
  routeIncomingMock: vi.fn<(...args: unknown[]) => Promise<{ status: string }>>(async () => ({
    status: 'answered',
  })),
  finishSupportMock: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  claimOnceMock: vi.fn(async () => true),
  state: { botAiEnabled: false, supportAiEnabled: true, persist: true as boolean },
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
  checkRateLimit: vi.fn(async () => ({ allowed: true, configured: false, limit: 0, remaining: 0 })),
}));
vi.mock('./send', () => ({
  sendSafely: h.sendMock,
  showOrEdit: vi.fn(async () => undefined),
}));
vi.mock('./persist', () => ({
  persistInbound: vi.fn(async () => (h.state.persist ? { userId: 'u1', conversationId: 'c1' } : null)),
  resolveCallbackContext: vi.fn(async () =>
    h.state.persist ? { userId: 'u1', conversationId: 'c1' } : null,
  ),
  readPendingMeta: vi.fn(async () => null),
  safeAppendMessage: h.appendMock,
}));
vi.mock('./agent-dialog', () => ({ runAgentDialog: vi.fn(async () => undefined) }));
vi.mock('./bot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bot')>();
  return { ...actual, getBot: () => ({ api: { answerCallbackQuery: vi.fn(async () => {}) } }) };
});
vi.mock('./start-menu', () => ({ handleStartCommand: h.startMock }));
vi.mock('./support-flow', async (importOriginal) => {
  // ⚠️ `extractSupportInline` берём НАСТОЯЩУЮ, а не мок: тест на лейбл
  // reply-кнопки проверяет именно её разбор. Подменённая заглушка сделала бы
  // регресс-тест декоративным.
  const actual = await importOriginal<typeof import('./support-flow')>();
  return {
    extractSupportInline: actual.extractSupportInline,
    handleSupportCallback: h.supportCallbackMock,
    handleSupportCommand: h.supportCommandMock,
    tryHandlePendingSupport: vi.fn(async () => false),
  };
});
vi.mock('./support-session', () => ({
  isSupportAiEnabled: () => h.state.supportAiEnabled,
  openSupportFromBot: h.openSupportMock,
  routeSupportIncoming: h.routeIncomingMock,
  finishSupportFromBot: h.finishSupportMock,
  resetSupportOnStart: vi.fn(async () => undefined),
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
import { __resetMediaGroupMemory, __resetSilentHintMemory } from './silent-hint';
import { SILENT_TEXT_HINT } from './templates';

let updateId = 5000;

function textUpdate(text: string) {
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: 'private' as const },
      from: { id: 7, is_bot: false, first_name: 'Клиент' },
      text,
    },
  };
}

function photoUpdate(mediaGroupId?: string) {
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: 'private' as const },
      from: { id: 7, is_bot: false, first_name: 'Клиент' },
      photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 10, height: 10 }],
      ...(mediaGroupId ? { media_group_id: mediaGroupId } : {}),
    },
  };
}

function callbackUpdate(data: string) {
  return {
    update_id: ++updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: 7, is_bot: false, first_name: 'Клиент' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: 'private' as const },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSilentHintMemory();
  __resetMediaGroupMemory();
  h.state.botAiEnabled = false;
  h.state.supportAiEnabled = true;
  h.state.persist = true;
  h.routeIncomingMock.mockResolvedValue({ status: 'answered' });
  h.openSupportMock.mockResolvedValue({ status: 'opened' });
});

describe('вход в поддержку', () => {
  it('кнопка «Поддержка» открывает сессию помощника', async () => {
    await handleTelegramUpdate(callbackUpdate('support') as never);

    expect(h.openSupportMock).toHaveBeenCalledTimes(1);
    expect(h.openSupportMock.mock.calls[0]?.[4]).toBe('button');
    expect(h.supportCallbackMock).not.toHaveBeenCalled();
  });

  it('команда /support открывает сессию, а не старый двухшаговый флоу', async () => {
    await handleTelegramUpdate(textUpdate('/support') as never);

    expect(h.openSupportMock.mock.calls[0]?.[4]).toBe('command');
    expect(h.supportCommandMock).not.toHaveBeenCalled();
  });

  it('однострочная «/support <текст>» обрабатывает текст как первое сообщение сессии', async () => {
    await handleTelegramUpdate(textUpdate('/support не приходит ссылка') as never);

    expect(h.openSupportMock).toHaveBeenCalledTimes(1);
    expect(h.routeIncomingMock.mock.calls[0]?.[4]).toMatchObject({
      text: 'не приходит ссылка',
      kind: 'text',
    });
  });

  it('голая /support первым сообщением не считается — помощник ждёт вопрос', async () => {
    await handleTelegramUpdate(textUpdate('/support') as never);
    expect(h.routeIncomingMock).not.toHaveBeenCalled();
  });

  it('РЕГРЕСС: лейбл reply-кнопки не уходит модели как вопрос клиента', async () => {
    // Нажатие старой reply-кнопки приходит ТЕКСТОМ «Написать в поддержку» без
    // префикса `/support`. Наивная обрезка префикса отдавала бы подпись кнопки
    // модели как первое сообщение — и жгла ход из суточного лимита.
    await handleTelegramUpdate(textUpdate('Написать в поддержку') as never);

    expect(h.openSupportMock).toHaveBeenCalledTimes(1);
    expect(h.routeIncomingMock).not.toHaveBeenCalled();
  });

  it('сессия уже открыта — приветствия нет, но и молчания нет', async () => {
    h.openSupportMock.mockResolvedValue({ status: 'already_open' });
    await handleTelegramUpdate(textUpdate('/support') as never);

    expect(h.sendMock).toHaveBeenCalledTimes(1);
    expect(String(h.sendMock.mock.calls[0]?.[1])).toContain('Я на связи');
  });

  it('состояние не прочитать — уходим в сегодняшний флоу, а не молчим', async () => {
    h.openSupportMock.mockResolvedValue({ status: 'unavailable' });
    await handleTelegramUpdate(textUpdate('/support') as never);

    expect(h.supportCommandMock).toHaveBeenCalledTimes(1);
  });

  it('кнопка «Завершить» закрывает сессию, а не открывает новую', async () => {
    await handleTelegramUpdate(callbackUpdate('support:finish') as never);

    expect(h.finishSupportMock).toHaveBeenCalledTimes(1);
    expect(h.openSupportMock).not.toHaveBeenCalled();
  });
});

describe('выключенный помощник', () => {
  beforeEach(() => {
    h.state.supportAiEnabled = false;
  });

  it('кнопка ведёт в сегодняшний флоу к человеку', async () => {
    await handleTelegramUpdate(callbackUpdate('support') as never);

    expect(h.supportCallbackMock).toHaveBeenCalledTimes(1);
    expect(h.openSupportMock).not.toHaveBeenCalled();
  });

  it('команда ведёт в сегодняшний флоу к человеку', async () => {
    await handleTelegramUpdate(textUpdate('/support') as never);

    expect(h.supportCommandMock).toHaveBeenCalledTimes(1);
    expect(h.openSupportMock).not.toHaveBeenCalled();
  });

  it('свободный текст в модуль поддержки не заходит вовсе', async () => {
    await handleTelegramUpdate(textUpdate('помогите') as never);
    expect(h.routeIncomingMock).not.toHaveBeenCalled();
  });
});

describe('недоступная БД', () => {
  beforeEach(() => {
    h.state.persist = false;
  });

  it('кнопка при включённом помощнике падает в сегодняшний флоу, а не в тишину', async () => {
    await handleTelegramUpdate(callbackUpdate('support') as never);
    expect(h.supportCallbackMock).toHaveBeenCalledTimes(1);
  });

  it('команда при включённом помощнике падает в сегодняшний флоу', async () => {
    await handleTelegramUpdate(textUpdate('/support') as never);
    expect(h.supportCommandMock).toHaveBeenCalledTimes(1);
  });
});

describe('свободный текст', () => {
  it('в сессии помощника обрабатывается модулем и дальше не идёт', async () => {
    await handleTelegramUpdate(textUpdate('когда придёт карта?') as never);

    expect(h.routeIncomingMock).toHaveBeenCalledTimes(1);
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('РЕГРЕСС V2: в сессии реплику клиента бот НЕ пишет — её пишет модуль, иначе дубль в ленте', async () => {
    await handleTelegramUpdate(textUpdate('когда придёт карта?') as never);

    expect(h.appendMock).not.toHaveBeenCalled();
    // Meta бота (id апдейта/сообщения) уезжает модулю, чтобы строка была
    // неотличима от той, что писал бы бот.
    expect(h.routeIncomingMock.mock.calls[0]?.[4]).toMatchObject({
      userMeta: expect.objectContaining({ telegram_message_id: expect.any(Number) }),
    });
  });

  it('вне сессии (idle) реплику клиента пишет бот, как раньше', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'not_in_session' });
    await handleTelegramUpdate(textUpdate('помогите') as never);

    // Одна реплика клиента (вторая запись — подсказка `assistant`, это норма).
    const userWrites = h.appendMock.mock.calls.filter((c) => c[1] === 'user');
    expect(userWrites).toHaveLength(1);
  });

  it('вне сессии (idle) — прежняя подсказка с кнопкой: обращение создаёт только нажатие', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'not_in_session' });
    await handleTelegramUpdate(textUpdate('помогите') as never);

    expect(h.sendMock).toHaveBeenCalledTimes(1);
    expect(h.sendMock.mock.calls[0]?.[1]).toBe(SILENT_TEXT_HINT);
  });

  it('разговор ведёт оператор — бот молчит и не вклинивается второй репликой', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'operator_leads' });
    await handleTelegramUpdate(textUpdate('ещё вопрос') as never);

    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('состояние прочитать нечем — работает сегодняшняя подсказка', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'state_unavailable' });
    await handleTelegramUpdate(textUpdate('помогите') as never);

    expect(h.sendMock.mock.calls[0]?.[1]).toBe(SILENT_TEXT_HINT);
  });
});

describe('медиа', () => {
  it('РЕГРЕСС V3: хвост альбома молчит — первое фото уже получило ответ', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'media_rejected' });
    await handleTelegramUpdate(photoUpdate('album-1') as never);
    await handleTelegramUpdate(photoUpdate('album-1') as never);
    await handleTelegramUpdate(photoUpdate('album-1') as never);

    expect(h.routeIncomingMock).toHaveBeenCalledTimes(1);
    // Ни одной подсказки «картинки не разбираю» поверх ответа помощника.
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('в сессии помощника разбирается модулем — подсказка не дублируется', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'media_rejected' });
    await handleTelegramUpdate(photoUpdate() as never);

    expect(h.routeIncomingMock.mock.calls[0]?.[4]).toMatchObject({ kind: 'media', mediaKind: 'photo' });
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('вне сессии — прежняя подсказка про картинки', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'not_in_session' });
    await handleTelegramUpdate(photoUpdate() as never);

    expect(h.sendMock).toHaveBeenCalledTimes(1);
  });
});
