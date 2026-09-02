import { describe, expect, it } from 'vitest';

import { applyAskResponse, buildAskBody, EMPTY_CHAT, type ChatState } from './chat-state';

/**
 * Состояние чата с аналитиком (тикет 07) — без DOM: что уходит в запрос и что
 * происходит с лентой после ответа. Эфемерность — свойство компонента (state в
 * памяти), здесь проверяются решения.
 */

const withTurns: ChatState = {
  turns: [
    { role: 'user', text: 'Сколько заказов?' },
    {
      role: 'assistant',
      text: 'Семь.',
      toolCalls: [{ sql: 'SELECT 1', columns: ['n'], rows: [[7]], truncated: false, error: null, errorReason: null }],
    },
    { role: 'user', text: 'А за месяц?' },
  ],
  error: null,
  failedToolCalls: [],
};

describe('buildAskBody', () => {
  it('история из трёх ходов уходит в теле следующего запроса — только роль и текст, без таблиц', () => {
    const body = buildAskBody(withTurns, '  А выручка?  ');
    expect(body).toEqual({
      question: 'А выручка?',
      history: [
        { role: 'user', text: 'Сколько заказов?' },
        { role: 'assistant', text: 'Семь.' },
        { role: 'user', text: 'А за месяц?' },
      ],
    });
  });

  it('длинная история режется с начала до 20 ходов', () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `t${i}`,
    }));
    const body = buildAskBody({ ...EMPTY_CHAT, turns }, 'q');
    expect(body.history).toHaveLength(20);
    expect(body.history[0]?.text).toBe('t10');
  });
});

describe('applyAskResponse', () => {
  it('успех добавляет вопрос и ответ с запросами, ошибка снимается', () => {
    const next = applyAskResponse(
      { ...EMPTY_CHAT, error: 'rate_limited' },
      'Сколько?',
      {
        ok: true,
        data: {
          ok: true,
          answer: 'Семь.',
          toolCalls: [{ sql: 'SELECT 1', columns: ['n'], rows: [[7]], truncated: true, error: null }],
          incomplete: false,
        },
      },
    );
    expect(next.error).toBeNull();
    expect(next.turns).toHaveLength(2);
    expect(next.turns[1]).toMatchObject({
      role: 'assistant',
      text: 'Семь.',
      toolCalls: [{ sql: 'SELECT 1', truncated: true }],
    });
  });

  it('после ошибки лента не меняется — вопрос остаётся в поле; код ошибки и выполненные запросы сохраняются', () => {
    const next = applyAskResponse(withTurns, 'Зациклись', {
      ok: true,
      data: {
        ok: false,
        error: 'max_iterations',
        toolCalls: [{ sql: 'SELECT 1', columns: [], rows: [], truncated: false, error: 'timeout' }],
      },
    });
    expect(next.turns).toEqual(withTurns.turns);
    expect(next.error).toBe('max_iterations');
    expect(next.failedToolCalls).toHaveLength(1);
  });

  it('HTTP-ошибка без тела → unavailable', () => {
    const next = applyAskResponse(withTurns, 'q', { ok: false, data: null });
    expect(next.error).toBe('unavailable');
    expect(next.turns).toEqual(withTurns.turns);
  });

  it('мусор в toolCalls не роняет разбор', () => {
    const next = applyAskResponse(EMPTY_CHAT, 'q', {
      ok: true,
      data: { ok: true, answer: 'x', toolCalls: [null, 'str', { sql: 1, rows: 'no' }] },
    });
    expect(next.turns[1]?.toolCalls).toEqual([
      { sql: '', columns: [], rows: [], truncated: false, error: null, errorReason: null },
    ]);
  });
});
