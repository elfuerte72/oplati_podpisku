import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.APP_URL = 'https://example.com';
process.env.TELEGRAM_BOT_TOKEN = '123:test-token';

/**
 * Диспетчеризация кнопок воронки: неймспейс `fb:*` доезжает до
 * `handleFunnelCallback` через существующий шов диспетчера апдейтов — и
 * работает при ВЫКЛЮЧЕННОМ BOT_AI_ENABLED (кнопки воронки — не каталог).
 * Поведение самих обработчиков — funnel-callbacks.test.ts.
 */

const h = vi.hoisted(() => ({
  funnelMock: vi.fn(async (..._args: unknown[]) => undefined),
  state: { botAiEnabled: false },
}));

vi.mock('@/lib/analytics/track', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/dedup', () => ({
  claimOnce: vi.fn(async () => true),
  releaseClaim: vi.fn(async () => undefined),
}));
vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'BOT_AI_ENABLED') return h.state.botAiEnabled;
        if (prop === 'TELEGRAM_BOT_TOKEN') return '123:test-token';
        return undefined;
      },
    },
  ),
}));
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, configured: false, limit: 0, remaining: 0 })),
}));
vi.mock('./send', () => ({ sendSafely: vi.fn(async () => true), showOrEdit: vi.fn() }));
vi.mock('./persist', () => ({
  persistInbound: vi.fn(async () => ({ userId: 'u1', conversationId: 'c1' })),
  resolveCallbackContext: vi.fn(async () => ({ userId: 'u1', conversationId: 'c1' })),
  readPendingMeta: vi.fn(async () => null),
  safeAppendMessage: vi.fn(async () => undefined),
}));
vi.mock('./agent-dialog', () => ({ runAgentDialog: vi.fn(async () => undefined) }));
vi.mock('./bot', () => ({
  getBot: () => ({ api: { answerCallbackQuery: vi.fn(async () => ({})) } }),
}));
vi.mock('./start-menu', () => ({ handleStartCommand: vi.fn(async () => undefined) }));
vi.mock('./support-entry', () => ({ openSupportEntry: vi.fn(async () => undefined) }));
vi.mock('./support-flow', () => ({
  extractSupportInline: () => null,
  handleSupportCommand: vi.fn(async () => undefined),
  tryHandlePendingSupport: vi.fn(async () => false),
}));
vi.mock('./support-session', () => ({
  isSupportAiEnabled: () => false,
  openSupportFromBot: vi.fn(async () => ({ status: 'opened' })),
  routeSupportIncoming: vi.fn(async () => ({ status: 'answered' })),
  finishSupportFromBot: vi.fn(async () => undefined),
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
vi.mock('./funnel-callbacks', () => ({ handleFunnelCallback: h.funnelMock }));

import { handleTelegramUpdate } from './handle-update';

let updateId = 7000;

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
  h.state.botAiEnabled = false;
});

describe('диспетчер: неймспейс fb:*', () => {
  it('fb:optout доезжает до handleFunnelCallback при выключенном BOT_AI_ENABLED', async () => {
    await handleTelegramUpdate(callbackUpdate('fb:optout') as never);

    expect(h.funnelMock).toHaveBeenCalledTimes(1);
    const [, chatId, parts] = h.funnelMock.mock.calls[0]! as [unknown, number, string[]];
    expect(chatId).toBe(42);
    expect(parts).toEqual(['fb', 'optout']);
  });

  it('fb:rate:5:<orderId> передаёт все сегменты данных', async () => {
    await handleTelegramUpdate(callbackUpdate('fb:rate:5:abc-123') as never);

    const [, , parts] = h.funnelMock.mock.calls[0]! as [unknown, number, string[]];
    expect(parts).toEqual(['fb', 'rate', '5', 'abc-123']);
  });
});
