import { describe, expect, it } from 'vitest';

import { DedupWindow } from './dedup-window';

/**
 * Окно дедупа DM-алертов.
 *
 * ⚠️ Главное здесь — РАЗНЫЕ окна в одном экземпляре. Уведомления персоналу
 * ходят через один `DedupWindow`, но окно задаётся на вызов: холд банка молчит
 * час, «баланс между порогами» — сутки. Пока запись хранила МОМЕНТ отправки,
 * а чистка шла по окну ВЫЗЫВАЮЩЕГО, часовое уведомление вычищало суточную
 * запись — и предупреждение о балансе начинало приходить каждые пять минут,
 * то есть ровно так, как алёрт умирает второй раз.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Не ноль: пустой Map отдаёт «никогда не слали», и с нулевым `now` это
// неотличимо от свежей записи.
const T0 = 1_000_000_000_000;

describe('DedupWindow', () => {
  it('окно занято до конца СВОЕГО срока', () => {
    const w = new DedupWindow(HOUR);

    expect(w.shouldSend('a', T0)).toBe(true);
    expect(w.shouldSend('a', T0 + HOUR - 1)).toBe(false);
    expect(w.shouldSend('a', T0 + HOUR)).toBe(true);
  });

  it('чужое КОРОТКОЕ окно не выбивает длинную запись', () => {
    const w = new DedupWindow(HOUR);
    // Суточное предупреждение о балансе.
    w.record('vcc_balance_low', T0, DAY);

    // Через два часа приходит обычное часовое уведомление о холде: оно
    // фиксируется само и попутно чистит протухшее.
    w.record('hold:1', T0 + 2 * HOUR, HOUR);

    // Суточная запись обязана уцелеть: её срок ещё не вышел.
    expect(w.isFree('vcc_balance_low', T0 + 2 * HOUR)).toBe(false);
    expect(w.isFree('vcc_balance_low', T0 + DAY)).toBe(true);
  });

  it('протухшие записи всё-таки убираются', () => {
    const w = new DedupWindow(HOUR);
    w.record('old', T0, HOUR);

    w.record('new', T0 + 2 * HOUR, HOUR);

    expect(w.isFree('old', T0 + 2 * HOUR)).toBe(true);
    expect(w.isFree('new', T0 + 2 * HOUR)).toBe(false);
  });

  it('isFree окно НЕ занимает', () => {
    // Иначе проверка перед отправкой съедала бы окно при сорванной доставке.
    const w = new DedupWindow(HOUR);

    expect(w.isFree('a', T0)).toBe(true);
    expect(w.isFree('a', T0)).toBe(true);
    expect(w.shouldSend('a', T0)).toBe(true);
  });

  it('разные ключи не мешают друг другу', () => {
    const w = new DedupWindow(HOUR);

    expect(w.shouldSend('a', T0)).toBe(true);
    expect(w.shouldSend('b', T0)).toBe(true);
    expect(w.shouldSend('a', T0)).toBe(false);
  });
});
