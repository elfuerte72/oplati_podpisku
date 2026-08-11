import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv (logger и пр.).
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.ANTHROPIC_API_KEY = 'test-anthropic';

const h = vi.hoisted(() => ({
  env: { WEB_AI_ENABLED: false },
  classifyMock: vi.fn(async () => ({ route: 'agent' as const, usage: null })),
  runAgentMock: vi.fn(async () => ({
    text: 'ответ агента',
    usage: { input_tokens: 1, output_tokens: 1 },
    toolCalls: [],
  })),
  runAgentNoToolsMock: vi.fn(async () => ({
    text: 'ответ без tools',
    usage: { input_tokens: 1, output_tokens: 1 },
  })),
  appendMock: vi.fn(async () => ({ id: 'm1' })),
  recordUsage: vi.fn(async (..._args: unknown[]) => undefined),
  AgentLoopError: class AgentLoopError extends Error {
    usage: unknown;
    reason = 'api_error';
    toolCalls: { name: string; isError: boolean }[];
    constructor(usage: unknown, toolCalls: { name: string; isError: boolean }[] = []) {
      super('loop failed');
      this.name = 'AgentLoopError';
      this.usage = usage;
      this.toolCalls = toolCalls;
    }
  },
}));

vi.mock('@/lib/env.server', () => ({ serverEnv: h.env }));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  appendMessage: h.appendMock,
  getOrCreateUserByWebSessionId: vi.fn(async () => ({ id: 'u1', created: false })),
  getOrCreateActiveConversation: vi.fn(async () => ({ id: 'c1', created: false })),
  loadRecentMessages: vi.fn(async () => []),
}));

vi.mock('@oplati/agent', () => ({
  // Реальный класс роут использует как ЗНАЧЕНИЕ (`err instanceof`): мок без
  // него оставлял бы веб-половину учёта usage непроверенной (ревью 2026-08-11).
  AgentLoopError: h.AgentLoopError,
  classifyMessage: h.classifyMock,
  runAgent: h.runAgentMock,
  runAgentNoTools: h.runAgentNoToolsMock,
}));

vi.mock('@/lib/ai/budget', () => ({
  BUDGET_EXCEEDED_TEXT: 'budget-exceeded',
  isAiBudgetExceeded: vi.fn(async () => false),
  mergeUsage: (_a: unknown, b: unknown) => b,
  recordAgentUsage: h.recordUsage,
}));

vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: () => '127.0.0.1',
}));

vi.mock('@/lib/chat/session', () => ({
  getOrCreateWebSessionId: vi.fn(async () => 'ws1'),
}));

vi.mock('@/lib/chat/history', () => ({
  toAgentHistory: (_history: unknown, text: string) => [{ role: 'user', content: text }],
}));

vi.mock('@/lib/tool-handlers', () => ({ createToolHandlers: () => ({}) }));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { POST } from './route.ts';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/chat — флаг WEB_AI_ENABLED', () => {
  beforeEach(() => {
    h.env.WEB_AI_ENABLED = false;
    h.classifyMock.mockClear();
    h.runAgentMock.mockClear();
    h.runAgentNoToolsMock.mockClear();
    h.appendMock.mockClear();
  });

  it('выключен (дефолт) → мгновенная заготовка: ни роутер, ни агент, ни БД', async () => {
    const resp = await POST(makeRequest({ message: 'привет' }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.text).toContain('Выбрать сервис');
    expect(body.toolCalls).toEqual([]);
    expect(h.classifyMock).not.toHaveBeenCalled();
    expect(h.runAgentMock).not.toHaveBeenCalled();
    expect(h.runAgentNoToolsMock).not.toHaveBeenCalled();
    expect(h.appendMock).not.toHaveBeenCalled();
  });

  it('выключен → невалидное тело по-прежнему 400 (контракт не размяк)', async () => {
    const resp = await POST(makeRequest({ message: '' }));
    expect(resp.status).toBe(400);
  });

  it('включён → обычный AI-путь: runAgent вызван, ответ агента уходит клиенту', async () => {
    h.env.WEB_AI_ENABLED = true;
    const resp = await POST(makeRequest({ message: 'привет' }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.text).toBe('ответ агента');
    expect(h.runAgentMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Дневной токен-бюджет считается по usage, который отдаёт агент. При `throw` он
 * терялся целиком — самые дорогие запросы записывались как ноль токенов (аудит
 * 2026-08-10, HIGH). Веб-половина этого фикса до ревью не проверялась вовсе:
 * мок `@oplati/agent` не отдавал класс ошибки.
 */
describe('POST /api/chat — сбой агента', () => {
  beforeEach(() => {
    h.env.WEB_AI_ENABLED = true;
    h.recordUsage.mockClear();
    h.appendMock.mockClear();
    h.runAgentMock.mockClear();
  });

  it('потраченные до сбоя токены попадают в бюджет', async () => {
    h.runAgentMock.mockRejectedValueOnce(
      new h.AgentLoopError({ input_tokens: 700, output_tokens: 90 }),
    );

    const res = await POST(makeRequest({ message: 'привет' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: 'ai_unavailable' });
    expect(h.recordUsage).toHaveBeenCalledWith({ input_tokens: 700, output_tokens: 90 });
  });
});
