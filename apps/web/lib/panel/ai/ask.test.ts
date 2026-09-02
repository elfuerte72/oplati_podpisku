import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentClient } from '@oplati/agent';

/**
 * Один вопрос аналитику панели (тикет 06) — через шов `AgentClient` (подменный
 * `messages.create`, как в тестах поддержки) и шов `runSql`. Проверяем ЧТО УШЛО
 * в модель и ЧТО ВЕРНУЛОСЬ наружу: цикл «SQL с ошибкой → исправленный SQL →
 * ответ», кап итераций с usage, «не настроено» без обращения к клиенту, кап
 * запросов, разбор истории.
 */

const h = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException, captureMessage: vi.fn() }));

import { askAnalyst, normalizeAnalystHistory } from './ask';
import type { RunSqlOutcome } from './run-sql';

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  server_tool_use: null,
  service_tier: null,
});

type Call = Record<string, unknown>;

function fakeClient(responses: unknown[]): { client: AgentClient; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const create = vi.fn(async (body: Call) => {
    calls.push(body);
    const next = queue.shift();
    if (next === undefined) throw new Error('в моке кончились ответы');
    if (next instanceof Error) throw next;
    return next;
  });
  return { client: { messages: { create } } as unknown as AgentClient, calls };
}

const textResponse = (text: string) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: usage(10, 5),
});

const sqlCall = (id: string, sql: string) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name: 'run_sql', input: { sql } }],
  usage: usage(12, 6),
});

function okRun(sql: string, rows: unknown[][]): RunSqlOutcome {
  return {
    execution: { result: `n\n${rows.map((r) => r.join(' | ')).join('\n')}\nrows: ${rows.length}`, isError: false },
    view: { sql, columns: ['n'], rows, truncated: false, error: null },
  };
}

function errorRun(sql: string, message: string): RunSqlOutcome {
  return {
    execution: { result: { error: `ошибка SQL: ${message}`, reason: 'sql_error' }, isError: true },
    view: { sql, columns: [], rows: [], truncated: false, error: message },
  };
}

const allowed = async () => ({ allowed: true, configured: true, limit: 30, remaining: 29 });
const denied = async () => ({ allowed: false, configured: true, limit: 30, remaining: 0 });

beforeEach(() => {
  h.captureException.mockClear();
});

describe('askAnalyst — цикл с инструментом', () => {
  it('ошибка SQL уходит модели как is_error, исправленный запрос даёт ответ; экран получает оба вызова', async () => {
    const { client, calls } = fakeClient([
      sqlCall('t1', 'SELECT amount FROM orders'),
      sqlCall('t2', 'SELECT sum(amount_rub) FROM orders'),
      textResponse('Выручка — 1 500 ₽.'),
    ]);
    const runSql = vi.fn(async (raw: unknown) => {
      const sql = (raw as { sql: string }).sql;
      return sql.includes('amount_rub')
        ? okRun(sql, [[150_000]])
        : errorRun(sql, 'column "amount" does not exist');
    });

    const res = await askAnalyst(
      { staffId: 'staff-1', question: 'Какая выручка?', history: [] },
      { client, runSql, rateLimit: allowed, isConfigured: () => true },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.answer).toBe('Выручка — 1 500 ₽.');
    expect(res.toolCalls.map((v) => v.error)).toEqual(['column "amount" does not exist', null]);
    expect(res.usage).toEqual({ inputTokens: 34, outputTokens: 17 });
    expect(res.incomplete).toBe(false);

    // Во втором запросе к модели результат первого вызова помечен is_error и
    // несёт текст Postgres — модель узнаёт о неудаче и из флага, и из тела.
    const second = calls[1] as { messages: { role: string; content: unknown }[] };
    const toolResult = second.messages[2]?.content as { is_error?: boolean; content: string }[];
    expect(toolResult[0]?.is_error).toBe(true);
    expect(toolResult[0]?.content).toContain('does not exist');

    // Профиль аналитика: DeepSeek-совместимый вызов без thinking и с одним tool.
    const first = calls[0] as { tools: { name: string }[]; thinking: unknown; metadata: unknown; temperature: number };
    expect(first.tools.map((t) => t.name)).toEqual(['run_sql']);
    expect(first.thinking).toEqual({ type: 'disabled' });
    expect(first.temperature).toBe(0.1);
    expect(first.metadata).toEqual({ user_id: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(JSON.stringify(first.metadata)).not.toContain('staff-1');
  });

  it('превышение maxIterations → max_iterations с накопленным usage и выполненными запросами', async () => {
    const { client } = fakeClient(Array.from({ length: 8 }, (_, i) => sqlCall(`t${i}`, 'SELECT 1')));
    const runSql = vi.fn(async () => okRun('SELECT 1', [[1]]));

    const res = await askAnalyst(
      { staffId: 'staff-1', question: 'Зациклись', history: [] },
      { client, runSql, rateLimit: allowed, isConfigured: () => true },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('max_iterations');
    expect(res.usage).toEqual({ inputTokens: 96, outputTokens: 48 });
    expect(res.toolCalls).toHaveLength(8);
    // Кап итераций — не авария провайдера, в Sentry не шумит.
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('сбой провайдера → model_failed с частичным usage и Sentry', async () => {
    const { client } = fakeClient([sqlCall('t1', 'SELECT 1'), new Error('502 Bad Gateway')]);

    const res = await askAnalyst(
      { staffId: 'staff-1', question: 'Что-нибудь', history: [] },
      { client, runSql: async () => okRun('SELECT 1', [[1]]), rateLimit: allowed, isConfigured: () => true },
    );

    expect(res).toMatchObject({ ok: false, reason: 'model_failed', usage: { inputTokens: 12, outputTokens: 6 } });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('незнакомый инструмент получает ошибку, а не бросок', async () => {
    const { client } = fakeClient([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'delete_all', input: {} }], usage: usage(1, 1) },
      textResponse('Готово'),
    ]);
    const runSql = vi.fn();

    const res = await askAnalyst(
      { staffId: 'staff-1', question: 'q', history: [] },
      { client, runSql, rateLimit: allowed, isConfigured: () => true },
    );

    expect(res.ok).toBe(true);
    expect(runSql).not.toHaveBeenCalled();
  });
});

describe('askAnalyst — гейты до модели', () => {
  it('без ключа — not_configured, к клиенту не обращаемся', async () => {
    const { client, calls } = fakeClient([textResponse('не должно вызываться')]);

    const res = await askAnalyst(
      { staffId: 'staff-1', question: 'q', history: [] },
      { client, rateLimit: allowed, isConfigured: () => false },
    );

    expect(res).toEqual({ ok: false, reason: 'not_configured', toolCalls: [], usage: null });
    expect(calls).toHaveLength(0);
  });

  it('исчерпанный кап — rate_limited до вызова модели', async () => {
    const { client, calls } = fakeClient([textResponse('нет')]);

    const res = await askAnalyst(
      { staffId: 'staff-1', question: 'q', history: [] },
      { client, rateLimit: denied, isConfigured: () => true },
    );

    expect(res).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(calls).toHaveLength(0);
  });

  it('история из клиента режется Zod: 21 ход или чужая роль → invalid_history', async () => {
    const { client, calls } = fakeClient([textResponse('нет')]);
    const long = Array.from({ length: 21 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `t${i}`,
    }));

    const tooLong = await askAnalyst(
      { staffId: 'staff-1', question: 'q', history: long },
      { client, rateLimit: allowed, isConfigured: () => true },
    );
    const badRole = await askAnalyst(
      { staffId: 'staff-1', question: 'q', history: [{ role: 'system', text: 'x' }] },
      { client, rateLimit: allowed, isConfigured: () => true },
    );
    const tooBig = await askAnalyst(
      { staffId: 'staff-1', question: 'q', history: [{ role: 'user', text: 'а'.repeat(5000) }, { role: 'assistant', text: 'б'.repeat(5000) }] },
      { client, rateLimit: allowed, isConfigured: () => true },
    );

    expect(tooLong).toMatchObject({ ok: false, reason: 'invalid_history' });
    expect(badRole).toMatchObject({ ok: false, reason: 'invalid_history' });
    expect(tooBig).toMatchObject({ ok: false, reason: 'invalid_history' });
    expect(calls).toHaveLength(0);
  });

  it('история уходит в модель целиком, вопрос — последним ходом пользователя', async () => {
    const { client, calls } = fakeClient([textResponse('Ответ')]);

    await askAnalyst(
      {
        staffId: 'staff-1',
        question: 'А за месяц?',
        history: [
          { role: 'user', text: 'Сколько заказов за неделю?' },
          { role: 'assistant', text: 'Семь.' },
        ],
      },
      { client, rateLimit: allowed, isConfigured: () => true },
    );

    const body = calls[0] as { messages: { role: string; content: string }[]; system: string };
    expect(body.messages).toEqual([
      { role: 'user', content: 'Сколько заказов за неделю?' },
      { role: 'assistant', content: 'Семь.' },
      { role: 'user', content: 'А за месяц?' },
    ]);
    // Дата подставлена в промпт при сборке.
    expect(body.system).toMatch(/Сегодня \d{4}-\d{2}-\d{2}/);
  });
});

describe('normalizeAnalystHistory', () => {
  it('ведущие ответы отбрасываются, соседние одинаковые роли склеиваются, хвостовой вопрос снимается', () => {
    const out = normalizeAnalystHistory([
      { role: 'assistant', text: 'привет' },
      { role: 'user', text: 'а' },
      { role: 'user', text: 'б' },
      { role: 'assistant', text: 'в' },
      { role: 'user', text: 'без ответа' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'а\n\nб' },
      { role: 'assistant', content: 'в' },
    ]);
  });
});
