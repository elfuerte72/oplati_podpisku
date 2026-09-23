import { describe, expect, it } from 'vitest';

import { PAY_BLOCK_TEXT, payBlockReason } from './pay-block.ts';

/**
 * Кнопка «Оплатить» больше не серая без объяснения (тикет 05, находка П8):
 * все семь клиентов, не дошедших до счёта, не заполнили почту. Нажатие с
 * пустой почтой говорит, чего не хватает, и ведёт к полю.
 */

describe('payBlockReason', () => {
  it('всё заполнено — оплату не держим', () => {
    expect(payBlockReason({ emailOk: true, phoneRequired: false, phoneOk: false })).toBeNull();
    expect(payBlockReason({ emailOk: true, phoneRequired: true, phoneOk: true })).toBeNull();
  });

  it('нет почты — почта, даже если и телефона нет: сначала то, что выше на экране', () => {
    expect(payBlockReason({ emailOk: false, phoneRequired: true, phoneOk: false })).toBe('email');
  });

  it('почта есть, телефон нужен по сумме и не заполнен — телефон', () => {
    expect(payBlockReason({ emailOk: true, phoneRequired: true, phoneOk: false })).toBe('phone');
  });

  it('телефон не нужен по сумме — его пустота не держит', () => {
    expect(payBlockReason({ emailOk: true, phoneRequired: false, phoneOk: false })).toBeNull();
  });

  it('тексты говорят, чего не хватает', () => {
    expect(PAY_BLOCK_TEXT.email).toBe('Укажи почту — без неё не выставим счёт');
    expect(PAY_BLOCK_TEXT.phone).toMatch(/телефон/i);
  });
});
