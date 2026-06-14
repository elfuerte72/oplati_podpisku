import { beforeEach, describe, expect, it, vi } from 'vitest';

// Env для lazy-валидации serverEnv (обязательные ключи схемы) — ДО импорта budget.ts.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.AI_DAILY_TOKEN_BUDGET = '1000';

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  getAiUsageForDay: vi.fn(),
  recordAiUsageDelta: vi.fn(),
  utcDayKey: () => '2026-06-11',
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { getAiUsageForDay } from '@oplati/db';
import { parseRouterLabel } from '@oplati/agent';

import { isAiBudgetExceeded, mergeUsage, weightedTokens } from './budget.ts';

const mockedGetUsage = vi.mocked(getAiUsageForDay);

describe('weightedTokens', () => {
  it('считает стоимость по весам (output x5, write x1.25, read x0.1, search x3334)', () => {
    expect(
      weightedTokens({
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 1000,
        webSearchRequests: 2,
      }),
    ).toBe(1000 + 500 + 1000 + 1250 + 6668);
  });

  it('нулевой usage — ноль', () => {
    expect(
      weightedTokens({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearchRequests: 0,
      }),
    ).toBe(0);
  });
});

describe('mergeUsage', () => {
  it('null + null → null; одна сторона null → другая как есть', () => {
    expect(mergeUsage(null, null)).toBeNull();
    const u = { input_tokens: 5, output_tokens: 2 };
    expect(mergeUsage(u, null)).toBe(u);
    expect(mergeUsage(undefined, u)).toBe(u);
  });

  it('складывает все счётчики, включая web_search', () => {
    const merged = mergeUsage(
      {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: null,
        server_tool_use: { web_search_requests: 1 },
      },
      {
        input_tokens: 200,
        output_tokens: 20,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: 500,
        server_tool_use: null,
      },
    );
    expect(merged).toEqual({
      input_tokens: 300,
      output_tokens: 30,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 500,
      server_tool_use: { web_search_requests: 1 },
    });
  });
});

describe('isAiBudgetExceeded (бюджет в тесте = 1000 взвешенных токенов)', () => {
  beforeEach(() => {
    mockedGetUsage.mockReset();
  });

  const totals = (inputTokens: number) => ({
    requests: 1,
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearchRequests: 0,
  });

  it('за день не было запросов → false', async () => {
    mockedGetUsage.mockResolvedValueOnce(null);
    await expect(isAiBudgetExceeded()).resolves.toBe(false);
  });

  it('ниже порога → false, на пороге и выше → true', async () => {
    mockedGetUsage.mockResolvedValueOnce(totals(999));
    await expect(isAiBudgetExceeded()).resolves.toBe(false);
    mockedGetUsage.mockResolvedValueOnce(totals(1000));
    await expect(isAiBudgetExceeded()).resolves.toBe(true);
  });

  it('ошибка БД → fail-open (false)', async () => {
    mockedGetUsage.mockRejectedValueOnce(new Error('db down'));
    await expect(isAiBudgetExceeded()).resolves.toBe(false);
  });
});

describe('parseRouterLabel (Haiku-роутер)', () => {
  it('маппит четыре класса, регистр и пунктуация не мешают', () => {
    expect(parseRouterLabel('PAYMENT')).toBe('agent');
    expect(parseRouterLabel(' greeting\n')).toBe('greeting');
    expect(parseRouterLabel('OFFTOPIC.')).toBe('offtopic');
    expect(parseRouterLabel('Injection')).toBe('injection');
  });

  it('неизвестное слово или пусто → agent (fail-open)', () => {
    expect(parseRouterLabel('')).toBe('agent');
    expect(parseRouterLabel('банан')).toBe('agent');
    expect(parseRouterLabel('CLASS: UNKNOWN')).toBe('agent');
  });
});
