import { describe, expect, it } from 'vitest';

import type { MessageHistoryItem } from '@oplati/db';

import { toAgentHistory } from './history.ts';

let seq = 0;
function msg(role: MessageHistoryItem['role'], content: string): MessageHistoryItem {
  seq += 1;
  return { id: `m-${seq}`, role, content, createdAt: new Date(2026, 0, 1, 0, 0, seq) };
}

describe('toAgentHistory', () => {
  it('окно, начинающееся с assistant, отрезается до user-first (регресс HIGH аудита 2026-07-18)', () => {
    // loadRecentMessages(…, 20) режет историю по количеству строк: при одной
    // непарной записи окно начинается с assistant и Anthropic отвечает 400
    // «first message must use the user role» на каждый последующий ход.
    const history = [
      msg('assistant', 'обрезанный ответ из прошлого окна'),
      msg('user', 'вопрос 1'),
      msg('assistant', 'ответ 1'),
      msg('user', 'вопрос 2'),
    ];

    const result = toAgentHistory(history, 'вопрос 2');

    expect(result[0]?.role).toBe('user');
    expect(result[result.length - 1]).toEqual({ role: 'user', content: 'вопрос 2' });
  });

  it('несколько ведущих assistant (после схлопывания) тоже отрезаются', () => {
    const history = [
      msg('assistant', 'кусок A'),
      msg('operator', 'кусок B от оператора'),
      msg('user', 'вопрос'),
    ];

    const result = toAgentHistory(history, 'вопрос');

    expect(result).toEqual([{ role: 'user', content: 'вопрос' }]);
  });

  it('история целиком из assistant → остаётся только текущий ввод', () => {
    const history = [msg('assistant', 'один'), msg('assistant', 'два')];

    const result = toAgentHistory(history, 'привет');

    expect(result).toEqual([{ role: 'user', content: 'привет' }]);
  });

  it('пустая история → текущий ввод как единственное user-сообщение', () => {
    expect(toAgentHistory([], 'привет')).toEqual([{ role: 'user', content: 'привет' }]);
  });

  it('схлопывает подряд идущие одинаковые роли через \\n\\n', () => {
    const history = [
      msg('user', 'раз'),
      msg('user', 'два'),
      msg('assistant', 'ответ'),
      msg('user', 'три'),
    ];

    const result = toAgentHistory(history, 'три');

    expect(result).toEqual([
      { role: 'user', content: 'раз\n\nдва' },
      { role: 'assistant', content: 'ответ' },
      { role: 'user', content: 'три' },
    ]);
  });

  it('operator мапится в assistant, system отбрасывается', () => {
    const history = [
      msg('user', 'вопрос'),
      msg('system', 'служебное'),
      msg('operator', 'ответ оператора'),
      msg('user', 'ещё вопрос'),
    ];

    const result = toAgentHistory(history, 'ещё вопрос');

    expect(result).toEqual([
      { role: 'user', content: 'вопрос' },
      { role: 'assistant', content: 'ответ оператора' },
      { role: 'user', content: 'ещё вопрос' },
    ]);
  });

  it('если последнее сообщение не user — дописывает currentUserText', () => {
    const history = [msg('user', 'вопрос'), msg('assistant', 'ответ')];

    const result = toAgentHistory(history, 'новый ввод');

    expect(result[result.length - 1]).toEqual({ role: 'user', content: 'новый ввод' });
  });
});
