import { describe, expect, it } from 'vitest';

import { isDeskQuiet } from './desk';

/**
 * Рабочий стол (тикет 08). Требование спеки §5.1 звучит непривычно: экран
 * обязан быть ПУСТЫМ в норме и обязан об этом сказать.
 */
describe('isDeskQuiet', () => {
  it('ничего не требует внимания — это «всё спокойно», а не поломка', () => {
    expect(isDeskQuiet({ pendingCount: 0, holdsCount: 0, balanceLow: false })).toBe(true);
  });

  it('недожатый заказ снимает спокойствие', () => {
    expect(isDeskQuiet({ pendingCount: 1, holdsCount: 0, balanceLow: false })).toBe(false);
  });

  it('холд банка снимает спокойствие', () => {
    expect(isDeskQuiet({ pendingCount: 0, holdsCount: 1, balanceLow: false })).toBe(false);
  });

  it('низкий баланс тревожен даже при полном отсутствии заказов', () => {
    // Пополнение VCC приходит T+1: «заказов нет, значит всё хорошо» — ровно то
    // рассуждение, из-за которого 14 августа упал оплаченный заказ на 11 680 ₽.
    expect(isDeskQuiet({ pendingCount: 0, holdsCount: 0, balanceLow: true })).toBe(false);
  });

  it('«не смотрели» — это НЕ «спокойно»', () => {
    // Роль без права на раздел не видит ни одной карточки. Фраза «недожатых
    // заказов нет, банк ничего не держит» была бы утверждением о том, чего мы
    // не проверяли.
    expect(isDeskQuiet({ pendingCount: null, holdsCount: 0, balanceLow: false })).toBe(false);
    expect(isDeskQuiet({ pendingCount: 0, holdsCount: null, balanceLow: false })).toBe(false);
    expect(isDeskQuiet({ pendingCount: 0, holdsCount: 0, balanceLow: null })).toBe(false);
  });
});
