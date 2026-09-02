import { describe, expect, it } from 'vitest';

import {
  ANALYST_HISTORY_MAX_BYTES,
  applyAskResponse,
  buildAskBody,
  EMPTY_CHAT,
  type ChatState,
} from './chat-state';

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

  it('тяжёлая история режется с начала под потолок байт сервера, свежие ходы остаются', () => {
    // Кириллица — два байта на символ: четыре ответа по 1500 символов уже не
    // влезают в 8 КБ, а сервер такую историю отвергает целиком.
    const turns = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `${i}`.repeat(1) + 'я'.repeat(1500),
    }));
    const body = buildAskBody({ ...EMPTY_CHAT, turns }, 'вопрос');
    const bytes = body.history.reduce((sum, t) => sum + Buffer.byteLength(t.text, 'utf8'), 0);
    expect(bytes).toBeLessThanOrEqual(ANALYST_HISTORY_MAX_BYTES);
    expect(body.history.length).toBeGreaterThan(0);
    // Уцелели именно последние ходы.
    expect(body.history.at(-1)?.text).toBe(turns.at(-1)?.text);
  });

  it('единственный ход тяжелее потолка уезжает обрезанным — чат не запирается отказом сервера', () => {
    // Ответ аналитика на 2000 токенов кириллицей — это 10-14 КБ: целиком он
    // получал бы 400 invalid_history на каждый следующий вопрос.
    const turns = [{ role: 'assistant' as const, text: `${'я'.repeat(9000)}хвост` }];
    const body = buildAskBody({ ...EMPTY_CHAT, turns }, 'q');
    expect(body.history).toHaveLength(1);
    const text = body.history[0]!.text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(ANALYST_HISTORY_MAX_BYTES);
    expect(text.startsWith('яяя')).toBe(true);
    expect(text.endsWith('хвост')).toBe(false);
    // Суррогатные пары не рвутся: эмодзи либо целое, либо отброшено.
    const emoji = [{ role: 'assistant' as const, text: '🙂'.repeat(3000) }];
    const cut = buildAskBody({ ...EMPTY_CHAT, turns: emoji }, 'q').history[0]!.text;
    expect(cut).not.toContain('\ufffd');
    expect([...cut].every((ch) => ch === '🙂' || ' […]'.includes(ch))).toBe(true);
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
