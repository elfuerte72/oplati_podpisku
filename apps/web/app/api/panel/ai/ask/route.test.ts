import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Вопрос аналитику из панели (тикет 07): гейты (роль, Origin, JSON), коды
 * ответа по причинам отказа, счастливый путь с подменённым `askAnalyst`.
 * Сам ход модели проверен в `lib/panel/ai/ask.test.ts`.
 */

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
  askAnalyst: vi.fn(),
}));

vi.mock('@/lib/panel/session', () => ({ readPanelActor: h.readPanelActor }));

vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    { get: (_t, prop: string) => (prop === 'PANEL_HOST' ? 'admin.oplatishka.com' : undefined) },
  ),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'admin.oplatishka.com' }),
}));

vi.mock('@/lib/panel/ai/ask', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/panel/ai/ask')>();
  return { ...actual, askAnalyst: h.askAnalyst };
});

import { POST } from './route.ts';

const STAFF_ID = '00000000-0000-4000-8000-0000000000ff';

function actor(role: 'admin' | 'operator') {
  return {
    id: STAFF_ID,
    email: 'owner@example.com',
    displayName: 'Владелец',
    role,
    telegramId: '1',
    lastLoginAt: null,
  };
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://admin.oplatishka.com/api/panel/ai/ask', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://admin.oplatishka.com',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const toolCall = {
  sql: 'SELECT count(*) FROM orders',
  columns: ['count'],
  rows: [[7]],
  truncated: false,
  error: null,
};

beforeEach(() => {
  h.readPanelActor.mockReset();
  h.askAnalyst.mockReset();
  h.readPanelActor.mockImplementation(async () => actor('admin'));
  h.askAnalyst.mockImplementation(async () => ({
    ok: true,
    answer: 'Семь заказов.',
    toolCalls: [toolCall],
    usage: { inputTokens: 10, outputTokens: 5 },
    incomplete: false,
  }));
});

describe('POST /api/panel/ai/ask — доступ', () => {
  it('менеджер получает 403 — инструмент владельца', async () => {
    h.readPanelActor.mockImplementation(async () => actor('operator'));

    const res = await POST(request({ question: 'сколько заказов?' }));

    expect(res.status).toBe(403);
    expect(h.askAnalyst).not.toHaveBeenCalled();
  });

  it('не вошедший — 401', async () => {
    h.readPanelActor.mockImplementation(async () => null);
    const res = await POST(request({ question: 'q' }));
    expect(res.status).toBe(401);
  });

  it('без Origin и с чужим Origin — отказ: вопрос стоит денег провайдеру', async () => {
    const noOrigin = new Request('https://admin.oplatishka.com/api/panel/ai/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'q' }),
    });
    expect((await POST(noOrigin)).status).toBe(403);
    expect((await POST(request({ question: 'q' }, { origin: 'https://www.oplatishka.com' }))).status).toBe(403);
    expect(h.askAnalyst).not.toHaveBeenCalled();
  });

  it('тело не application/json — отказ', async () => {
    const res = await POST(request({ question: 'q' }, { 'content-type': 'text/plain' }));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/panel/ai/ask — тело и коды', () => {
  it('счастливый путь: 200 с ответом, запросами и usage; актор — id сотрудника', async () => {
    const res = await POST(
      request({
        question: 'Сколько заказов за месяц?',
        history: [{ role: 'user', text: 'привет' }, { role: 'assistant', text: 'здравствуйте' }],
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      answer: 'Семь заказов.',
      toolCalls: [toolCall],
      usage: { inputTokens: 10, outputTokens: 5 },
      incomplete: false,
    });
    expect(h.askAnalyst).toHaveBeenCalledWith({
      staffId: STAFF_ID,
      question: 'Сколько заказов за месяц?',
      history: [{ role: 'user', text: 'привет' }, { role: 'assistant', text: 'здравствуйте' }],
    });
  });

  it('пустой вопрос, лишняя роль в истории, не-JSON — 400 до модели', async () => {
    expect((await POST(request({ question: '  ' }))).status).toBe(400);
    expect((await POST(request({ question: 'q', history: [{ role: 'system', text: 'x' }] }))).status).toBe(400);
    expect((await POST(request('не json'))).status).toBe(400);
    expect((await POST(request({ question: 'q'.repeat(2001) }))).status).toBe(400);
    expect(h.askAnalyst).not.toHaveBeenCalled();
  });

  it('без ключа → 503 not_configured', async () => {
    h.askAnalyst.mockImplementation(async () => ({ ok: false, reason: 'not_configured', toolCalls: [], usage: null }));
    const res = await POST(request({ question: 'q' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: 'not_configured' });
  });

  it('кап → 429; сбой модели → 502; кап итераций → 200 с ok:false и выполненными запросами', async () => {
    h.askAnalyst.mockImplementation(async () => ({ ok: false, reason: 'rate_limited', toolCalls: [], usage: null }));
    expect((await POST(request({ question: 'q' }))).status).toBe(429);

    h.askAnalyst.mockImplementation(async () => ({
      ok: false,
      reason: 'model_failed',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 0 },
    }));
    expect((await POST(request({ question: 'q' }))).status).toBe(502);

    h.askAnalyst.mockImplementation(async () => ({
      ok: false,
      reason: 'max_iterations',
      toolCalls: [toolCall],
      usage: { inputTokens: 96, outputTokens: 48 },
    }));
    const res = await POST(request({ question: 'q' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, error: 'max_iterations', toolCalls: [toolCall] });
  });
});
