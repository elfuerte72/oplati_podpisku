import { describe, expect, it } from 'vitest';

import { isDeskQuiet, menuBadges, type DeskSignals } from './desk';

const CALM: DeskSignals = {
  pendingCount: 0,
  holdsCount: 0,
  balanceLow: false,
  unansweredSupportCount: 0,
};

/**
 * Рабочий стол (тикет 08). Требование спеки §5.1 звучит непривычно: экран
 * обязан быть ПУСТЫМ в норме и обязан об этом сказать.
 */
describe('isDeskQuiet', () => {
  it('ничего не требует внимания — это «всё спокойно», а не поломка', () => {
    expect(isDeskQuiet({ ...CALM, pendingCount: 0, holdsCount: 0, balanceLow: false })).toBe(true);
  });

  it('недожатый заказ снимает спокойствие', () => {
    expect(isDeskQuiet({ ...CALM, pendingCount: 1, holdsCount: 0, balanceLow: false })).toBe(false);
  });

  it('холд банка снимает спокойствие', () => {
    expect(isDeskQuiet({ ...CALM, pendingCount: 0, holdsCount: 1, balanceLow: false })).toBe(false);
  });

  it('низкий баланс тревожен даже при полном отсутствии заказов', () => {
    // Пополнение VCC приходит T+1: «заказов нет, значит всё хорошо» — ровно то
    // рассуждение, из-за которого 14 августа упал оплаченный заказ на 11 680 ₽.
    expect(isDeskQuiet({ ...CALM, pendingCount: 0, holdsCount: 0, balanceLow: true })).toBe(false);
  });

  it('обращение без ответа снимает спокойствие', () => {
    expect(isDeskQuiet({ ...CALM, unansweredSupportCount: 1 })).toBe(false);
  });

  it('«не смотрели» — это НЕ «спокойно»', () => {
    // Роль без права на раздел не видит ни одной карточки. Фраза «недожатых
    // заказов нет, банк ничего не держит» была бы утверждением о том, чего мы
    // не проверяли.
    expect(isDeskQuiet({ ...CALM, pendingCount: null, holdsCount: 0, balanceLow: false })).toBe(false);
    expect(isDeskQuiet({ ...CALM, pendingCount: 0, holdsCount: null, balanceLow: false })).toBe(false);
    expect(isDeskQuiet({ ...CALM, pendingCount: 0, holdsCount: 0, balanceLow: null })).toBe(false);
    expect(isDeskQuiet({ ...CALM, unansweredSupportCount: null })).toBe(false);
  });
});

/**
 * Счётчики в меню (редизайн, тикет 02). Панель action-oriented: «есть ли
 * работа» должно быть видно из меню, а не выясняться обходом разделов.
 */
describe('menuBadges', () => {
  it('число работы показывается у своего раздела', () => {
    expect(menuBadges('operator', { pending: 4, support: 2 })).toEqual({ pending: 4, support: 2 });
  });

  it('ноль не показывается — ноль не выглядит как задача', () => {
    expect(menuBadges('admin', { pending: 0, support: 0 })).toEqual({});
  });

  it('«не получили» (null) отличается от нуля и тоже не показывается', () => {
    // База не ответила — счётчика нет; «0» здесь был бы утверждением о том,
    // чего мы не проверяли.
    expect(menuBadges('admin', { pending: null, support: 3 })).toEqual({ support: 3 });
  });

  it('раздел, закрытый роли, счётчика не получает даже при известном числе', () => {
    // Роль без прав (`supervisor` не выдаётся) не должна видеть числа по
    // разделам, которые всё равно не откроет.
    expect(menuBadges('supervisor', { pending: 4, support: 2 })).toEqual({});
  });
});
