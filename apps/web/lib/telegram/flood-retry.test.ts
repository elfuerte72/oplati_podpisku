import { describe, expect, it, vi } from 'vitest';

process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

import { Bot } from 'grammy';

import { withFloodRetry } from './bot.ts';

/**
 * Бот без сети: подменяем транспорт (`apiRoot` не нужен — трансформер стоит
 * выше, и нижним звеном служит наш собственный мок).
 */
function botWithResponses(responses: unknown[]) {
  const bot = new Bot('12345:TEST', { botInfo: BOT_INFO });
  const calls = { count: 0 };
  // Нижний трансформер играет роль сети: отдаёт заготовленные ответы по порядку.
  bot.api.config.use(async () => {
    const res = responses[Math.min(calls.count, responses.length - 1)];
    calls.count += 1;
    return res as never;
  });
  withFloodRetry(bot);
  return { bot, calls };
}

const BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: 'test',
  username: 'test_bot',
  can_join_groups: true as const,
  can_read_all_group_messages: false as const,
  supports_inline_queries: false as const,
  can_connect_to_business: false as const,
  has_main_web_app: false as const,
  can_manage_bots: false as const,
  has_topics_enabled: false as const,
  allows_users_to_create_topics: false as const,
};

const OK = { ok: true as const, result: { message_id: 1 } };
const floodOf = (retryAfter: number) => ({
  ok: false as const,
  error_code: 429,
  description: 'Too Many Requests',
  parameters: { retry_after: retryAfter },
});

describe('withFloodRetry', () => {
  it('429 с коротким retry_after повторяется и доходит', async () => {
    vi.useFakeTimers();
    const { bot, calls } = botWithResponses([floodOf(1), OK]);
    const promise = bot.api.sendMessage(1, 'hi');
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeDefined();
    expect(calls.count).toBe(2);
    vi.useRealTimers();
  });

  it('успешный ответ не трогаем — ни повторов, ни задержки', async () => {
    const { bot, calls } = botWithResponses([OK]);
    await bot.api.sendMessage(1, 'hi');
    expect(calls.count).toBe(1);
  });

  it('не-429 не повторяем: 403 «бот заблокирован» повтором не лечится', async () => {
    const { bot, calls } = botWithResponses([
      { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    ]);
    await expect(bot.api.sendMessage(1, 'hi')).rejects.toThrow();
    expect(calls.count).toBe(1);
  });

  it('длинный retry_after не ждём — роут вебхука важнее одного сообщения', async () => {
    const { bot, calls } = botWithResponses([floodOf(120), OK]);
    await expect(bot.api.sendMessage(1, 'hi')).rejects.toThrow();
    expect(calls.count).toBe(1);
  });

  it('повторы ограничены: бесконечно долбить флуд-контроль нельзя', async () => {
    vi.useFakeTimers();
    const { bot, calls } = botWithResponses([floodOf(1)]);
    const promise = bot.api.sendMessage(1, 'hi');
    const assertion = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
    // Исходная попытка + FLOOD_MAX_RETRIES.
    expect(calls.count).toBe(3);
    vi.useRealTimers();
  });
});
