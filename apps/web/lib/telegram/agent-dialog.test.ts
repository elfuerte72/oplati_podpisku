import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

const h = vi.hoisted(() => ({
  send: vi.fn(async (..._args: unknown[]) => undefined),
  runAgent: vi.fn(async () => ({
    text: 'ответ',
    usage: { input_tokens: 1, output_tokens: 1 },
    toolCalls: [],
  })),
  classify: vi.fn(async () => ({ route: 'agent' as const, usage: null })),
  budgetExceeded: vi.fn(async () => false),
  append: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('@oplati/agent', () => ({
  classifyMessage: h.classify,
  runAgent: h.runAgent,
  runAgentNoTools: h.runAgent,
}));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  loadRecentMessages: vi.fn(async () => []),
}));
vi.mock('@/lib/ai/budget', () => ({
  BUDGET_EXCEEDED_TEXT: 'бюджет',
  isAiBudgetExceeded: h.budgetExceeded,
  mergeUsage: () => null,
  recordAgentUsage: vi.fn(async () => {}),
}));
vi.mock('@/lib/tool-handlers', () => ({ createToolHandlers: () => ({}) }));
vi.mock('./send', () => ({
  sendSafely: h.send,
  splitForTelegram: (t: string) => [t],
  TELEGRAM_MESSAGE_LIMIT: 4096,
  withTypingIndicator: async (_chatId: number, fn: () => Promise<unknown>) => await fn(),
}));
vi.mock('./persist', () => ({ safeAppendMessage: h.append }));
vi.mock('./catalog-callbacks', () => ({ buildConfirmKeyboard: () => undefined }));

import { runAgentDialog } from './agent-dialog';

const update = { update_id: 1, message: { message_id: 1, chat: { id: 555, type: 'private' as const } } };

/**
 * Отсутствие `ANTHROPIC_API_KEY` выключало ВЕСЬ бот в роуте (аудит 2026-08-10).
 * Гейт переехал сюда, на AI-путь: кнопочные и платёжные флоу к Anthropic
 * отношения не имеют, а AI-диалог обязан деградировать понятным текстом, а не
 * исключением на каждое сообщение.
 */
describe('runAgentDialog без ключа Anthropic', () => {
  beforeEach(() => {
    h.send.mockClear();
    h.runAgent.mockClear();
    h.append.mockClear();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('отвечает понятным текстом и не зовёт агента', async () => {
    await runAgentDialog(update, 555, 'привет', null);
    expect(h.runAgent).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledOnce();
    expect(String(h.send.mock.calls[0]?.[1] ?? '')).toContain('не получается ответить');
  });

  it('зовёт /support, а не «оператор»: в боте это слово никто не обрабатывает', async () => {
    await runAgentDialog(update, 555, 'привет', null);
    const text = String(h.send.mock.calls[0]?.[1] ?? '');
    expect(text).toContain('/support');
    expect(text).not.toContain('«оператор»');
  });

  it('заготовленный ответ пишется в историю, а не только отправляется', async () => {
    // Иначе диалог копит подряд идущие user-строки, toAgentHistory схлопывает
    // их в один ход, и после восстановления AI агент отвечает на слипшийся
    // комок старых намерений (ревью 2026-08-11).
    const ctx = { userId: 'u1', conversationId: 'c1' };
    await runAgentDialog(update, 555, 'привет', ctx as never);
    expect(h.append).toHaveBeenCalledWith(
      ctx,
      'assistant',
      expect.stringContaining('/support'),
      expect.objectContaining({ source: 'ai_unavailable' }),
      expect.anything(),
    );
  });

  it('с ключом путь агента работает как прежде', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    await runAgentDialog(update, 555, 'привет', null);
    expect(h.runAgent).toHaveBeenCalledOnce();
  });
});
