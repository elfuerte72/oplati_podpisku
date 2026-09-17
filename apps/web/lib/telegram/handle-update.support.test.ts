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
  supportCommandMock: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  supportCallbackMock: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  // Типы моков заданы явно: `vi.fn(async () => ...)` выводит пустой кортеж
  // аргументов и союз из одного литерала, и тест перестаёт компилироваться,
  // как только проверяет реально переданный аргумент или другой исход.
  openSupportMock: vi.fn<(...args: unknown[]) => Promise<{ status: string }>>(async () => ({
    status: 'opened',
  })),
  routeIncomingMock: vi.fn<(...args: unknown[]) => Promise<{ status: string; trigger?: string }>>(async () => ({
    status: 'answered',
  })),
  finishSupportMock: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  pendingSupportMock: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => false),
  inboundAlertMock: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  claimOnceMock: vi.fn<(key: string, ttl: number) => Promise<boolean>>(async () => true),
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
    tryHandlePendingSupport: h.pendingSupportMock,
  };
});
vi.mock('./inbound-alert', () => ({ notifyStaffAboutInboundMessage: h.inboundAlertMock }));
vi.mock('@/lib/support/availability', () => ({
  isSupportAiAvailable: () => h.state.supportAiEnabled,
}));
vi.mock('./support-session', () => ({
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
import { SILENT_MEDIA_HINT, SILENT_TEXT_HINT } from './templates';

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

function photoUpdate(mediaGroupId?: string, caption?: string) {
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: 'private' as const },
      from: { id: 7, is_bot: false, first_name: 'Клиент' },
      photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 10, height: 10 }],
      ...(mediaGroupId ? { media_group_id: mediaGroupId } : {}),
      ...(caption ? { caption } : {}),
    },
  };
}

function voiceUpdate() {
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: 'private' as const },
      from: { id: 7, is_bot: false, first_name: 'Клиент' },
      voice: { file_id: 'v1', file_unique_id: 'uv1', duration: 3 },
    },
  };
}

/** Строки клиента, которые записал БОТ (модуль замокан и пишет сам). */
function botUserRows(): unknown[][] {
  return h.appendMock.mock.calls.filter((c) => c[1] === 'user');
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
  h.pendingSupportMock.mockResolvedValue(false);
  h.claimOnceMock.mockImplementation(async () => true);
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
    // Так отвечает настоящий модуль без помощника в свободном разговоре.
    h.openSupportMock.mockResolvedValue({ status: 'unavailable' });
  });

  it('кнопка в свободном разговоре ведёт в сегодняшний флоу, контекст второй раз не резолвится', async () => {
    await handleTelegramUpdate(callbackUpdate('support') as never);

    expect(h.openSupportMock.mock.calls[0]?.[4]).toBe('button');
    expect(h.supportCallbackMock).toHaveBeenCalledTimes(1);
    expect(h.supportCallbackMock.mock.calls[0]?.[3]).toEqual({ userId: 'u1', conversationId: 'c1' });
  });

  it('команда в свободном разговоре ведёт в сегодняшний флоу, «/support» в ленте ровно один раз', async () => {
    await handleTelegramUpdate(textUpdate('/support') as never);

    expect(h.supportCommandMock).toHaveBeenCalledTimes(1);
    expect(h.supportCommandMock.mock.calls[0]?.[4]).toMatchObject({ commandRecorded: true });
    expect(botUserRows().map((c) => c[2])).toEqual(['/support']);
  });

  /**
   * Находка ревью: без чтения режима на входе кнопка в разговоре у оператора
   * запускала «опишите проблему», описание перехватывал модуль, и клиенту не
   * отвечало ничего.
   */
  it('кнопка в разговоре у оператора: двухшагового флоу нет — модуль сказал, кто ведёт', async () => {
    h.openSupportMock.mockResolvedValue({ status: 'operator_leads' });
    await handleTelegramUpdate(callbackUpdate('support') as never);

    expect(h.supportCallbackMock).not.toHaveBeenCalled();
  });

  it('команда в разговоре у оператора: двухшагового флоу нет', async () => {
    h.openSupportMock.mockResolvedValue({ status: 'operator_leads' });
    await handleTelegramUpdate(textUpdate('/support') as never);

    expect(h.supportCommandMock).not.toHaveBeenCalled();
    expect(h.routeIncomingMock).not.toHaveBeenCalled();
  });

  it('голая /support модуль не зовёт: первым сообщением она не считается', async () => {
    await handleTelegramUpdate(textUpdate('/support') as never);
    expect(h.routeIncomingMock).not.toHaveBeenCalled();
  });

  /**
   * crm-serious-fixes, тикет 01. Помощник — выключатель МОДЕЛИ, а не учёта:
   * режим разговора бот читает всегда. До тикета при выключенном флаге модуль
   * не звался, и ответ клиента оператору терял маркер обращения.
   */
  it('свободный текст идёт в модуль: режим разговора читается всегда', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'not_in_session' });
    await handleTelegramUpdate(textUpdate('помогите') as never);

    expect(h.routeIncomingMock).toHaveBeenCalledTimes(1);
    expect(h.routeIncomingMock.mock.calls[0]?.[4]).toMatchObject({ text: 'помогите', kind: 'text' });
  });

  it('разговор у оператора: ни подсказки «нажмите кнопку», ни второго уведомления, ни второй строки', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'operator_leads' });
    await handleTelegramUpdate(textUpdate('заказ 1234, деньги списали') as never);

    expect(h.sendMock).not.toHaveBeenCalled();
    // Персоналу уже ушёл пинг модуля со своим дедупом по БД — второй канал
    // дал бы два сообщения на одну реплику.
    expect(h.inboundAlertMock).not.toHaveBeenCalled();
    // Реплику с маркером пишет модуль; бот её не дублирует.
    expect(botUserRows()).toHaveLength(0);
    expect(h.pendingSupportMock).not.toHaveBeenCalled();
  });

  it('помощник пропал посреди сессии: разговор ушёл человеку, бот не добавляет подсказку', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'escalated', trigger: 'ai_unavailable' });
    await handleTelegramUpdate(textUpdate('где карта?') as never);

    expect(h.sendMock).not.toHaveBeenCalled();
    expect(botUserRows()).toHaveLength(0);
  });

  it('idle: как сегодня — реплику пишет бот, подсказка с кнопкой, уведомление персоналу', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'not_in_session' });
    await handleTelegramUpdate(textUpdate('помогите') as never);

    expect(botUserRows()).toHaveLength(1);
    expect(h.sendMock.mock.calls[0]?.[1]).toBe(SILENT_TEXT_HINT);
    expect(h.inboundAlertMock).toHaveBeenCalledTimes(1);
  });

  it('описание после кнопки «Поддержка» в idle уходит сегодняшним флоу', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'not_in_session' });
    h.pendingSupportMock.mockResolvedValue(true);
    await handleTelegramUpdate(textUpdate('не приходит ссылка на оплату') as never);

    expect(h.pendingSupportMock).toHaveBeenCalledTimes(1);
    expect(h.pendingSupportMock.mock.calls[0]?.[3]).toBe('не приходит ссылка на оплату');
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('состояние прочитать нечем — сегодняшняя подсказка, а не тишина', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'state_unavailable' });
    await handleTelegramUpdate(textUpdate('помогите') as never);

    expect(h.sendMock.mock.calls[0]?.[1]).toBe(SILENT_TEXT_HINT);
    expect(h.inboundAlertMock).toHaveBeenCalledTimes(1);
  });

  it('«/support <текст>» в разговоре у оператора: реплика уходит модулем, повторного обращения нет', async () => {
    h.openSupportMock.mockResolvedValue({ status: 'operator_leads' });
    h.routeIncomingMock.mockResolvedValue({ status: 'operator_leads' });
    await handleTelegramUpdate(textUpdate('/support деньги списали') as never);

    // «Обращение у оператора» клиенту говорит модуль на входе; текст после
    // команды становится продолжением обращения — маркер ставит модуль.
    expect(h.routeIncomingMock.mock.calls[0]?.[4]).toMatchObject({ text: 'деньги списали', kind: 'text' });
    expect(h.supportCommandMock).not.toHaveBeenCalled();
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('«/support <текст>» вне разговора с оператором — сегодняшний двухшаговый флоу', async () => {
    await handleTelegramUpdate(textUpdate('/support деньги списали') as never);

    expect(h.routeIncomingMock).not.toHaveBeenCalled();
    expect(h.supportCommandMock).toHaveBeenCalledTimes(1);
    expect(h.supportCommandMock.mock.calls[0]?.[4]).toMatchObject({ commandRecorded: true });
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('фото в idle: бот пишет ровно одну строку-плейсхолдер и шлёт подсказку', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'not_in_session' });
    await handleTelegramUpdate(photoUpdate() as never);

    expect(h.routeIncomingMock.mock.calls[0]?.[4]).toMatchObject({ kind: 'media', mediaKind: 'photo' });
    expect(botUserRows()).toHaveLength(1);
    expect(botUserRows()[0]?.[2]).toBe('[фото]');
    expect(h.sendMock.mock.calls[0]?.[1]).toBe(SILENT_MEDIA_HINT);
    // Персоналу — та же пометка, что в ленте, а не сырой тип вложения.
    expect(h.inboundAlertMock.mock.calls[0]?.[0]).toMatchObject({ text: '[фото]' });
  });

  it('РЕГРЕСС ревью: скриншот после кнопки «Поддержка» не затирает ожидание описания', async () => {
    // Флаг «ждём описание» читается из последней строки бота. Строка подсказки
    // на вложение затёрла бы его, и текстовое описание обращением не стало бы.
    h.routeIncomingMock.mockResolvedValue({ status: 'not_in_session' });
    await handleTelegramUpdate(photoUpdate() as never);

    expect(h.appendMock.mock.calls.filter((c) => c[1] === 'assistant')).toHaveLength(0);
  });

  it('кадр альбома с подписью пришёл вторым: подпись в ленте без второй пометки', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'not_in_session' });
    await handleTelegramUpdate(photoUpdate('album-caption-late') as never);
    await handleTelegramUpdate(photoUpdate('album-caption-late', 'вот ошибка') as never);

    expect(botUserRows().map((c) => c[2])).toEqual(['[фото]', 'вот ошибка']);
  });

  it('голосовое в idle: плейсхолдер своего типа, а не «[файл]»', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'not_in_session' });
    await handleTelegramUpdate(voiceUpdate() as never);

    expect(botUserRows()[0]?.[2]).toBe('[голосовое]');
  });

  it('фото у оператора: строку пишет модуль, бот молчит и не шлёт подсказку', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'media_rejected' });
    await handleTelegramUpdate(photoUpdate() as never);

    expect(botUserRows()).toHaveLength(0);
    expect(h.sendMock).not.toHaveBeenCalled();
    expect(h.inboundAlertMock).not.toHaveBeenCalled();
  });

  it('альбом из пяти фото в idle — одна строка и один поход в модуль', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'not_in_session' });
    for (let i = 0; i < 5; i += 1) await handleTelegramUpdate(photoUpdate('album-idle') as never);

    expect(h.routeIncomingMock).toHaveBeenCalledTimes(1);
    expect(botUserRows()).toHaveLength(1);
  });

  it('альбом при недоступном Redis (fail-open) — всё равно одна строка: держит память процесса', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'not_in_session' });
    // `claimOnce` fail-open отвечает «право твоё» на КАЖДЫЙ вызов.
    h.claimOnceMock.mockImplementation(async () => true);
    for (let i = 0; i < 5; i += 1) await handleTelegramUpdate(photoUpdate('album-no-redis') as never);

    expect(botUserRows()).toHaveLength(1);
  });

  it('альбом уже взял соседний процесс (Redis «занято») — этот процесс молчит', async () => {
    h.claimOnceMock.mockImplementation(async (key: string) => !key.startsWith('tg:album:'));
    await handleTelegramUpdate(photoUpdate('album-other-process') as never);

    expect(h.routeIncomingMock).not.toHaveBeenCalled();
    expect(botUserRows()).toHaveLength(0);
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('фото с подписью после кнопки «Поддержка»: в ленте и плейсхолдер, и подпись', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'not_in_session' });
    h.pendingSupportMock.mockResolvedValue(true);
    await handleTelegramUpdate(photoUpdate(undefined, 'вот скриншот ошибки') as never);

    expect(botUserRows()).toHaveLength(1);
    expect(botUserRows()[0]?.[2]).toBe('[фото] вот скриншот ошибки');
    // Оператору в обращение уходит то же, что в ленту: без плейсхолдера он не
    // узнал бы, что клиент прислал скриншот.
    expect(h.pendingSupportMock.mock.calls[0]?.[3]).toBe('[фото] вот скриншот ошибки');
  });

  it('фото с подписью у оператора: модуль получает подпись вместе с плейсхолдером', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'operator_leads' });
    await handleTelegramUpdate(photoUpdate(undefined, 'вот скриншот') as never);

    expect(h.routeIncomingMock.mock.calls[0]?.[4]).toMatchObject({
      text: '[фото] вот скриншот',
      kind: 'text',
    });
    expect(botUserRows()).toHaveLength(0);
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

  it('вне сессии — прежняя подсказка про картинки и строка-плейсхолдер в ленте', async () => {
    h.routeIncomingMock.mockResolvedValue({ status: 'not_in_session' });
    await handleTelegramUpdate(photoUpdate() as never);

    expect(h.sendMock).toHaveBeenCalledTimes(1);
    expect(botUserRows()).toHaveLength(1);
  });
});
