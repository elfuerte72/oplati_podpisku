import { describe, expect, it } from 'vitest';

import { toTelegramPlainText } from './plain-text';

describe('toTelegramPlainText', () => {
  it('жирный и курсив markdown снимаются: бот шлёт plain text, звёздочки видны буквально', () => {
    expect(toTelegramPlainText('Ваш заказ **оплачен**, карта __готовится__ и *скоро* будет.')).toBe(
      'Ваш заказ оплачен, карта готовится и скоро будет.',
    );
  });

  it('заголовки и маркеры списка — в обычный текст', () => {
    expect(toTelegramPlainText('### Что дальше\n- ждать карту\n* проверить почту')).toBe(
      'Что дальше\n— ждать карту\n— проверить почту',
    );
  });

  it('обратные кавычки кода снимаются, содержимое остаётся', () => {
    expect(toTelegramPlainText('Номер заказа `A1B2C3`.')).toBe('Номер заказа A1B2C3.');
  });

  it('арифметика и звёздочка как знак умножения не трогаются', () => {
    expect(toTelegramPlainText('12 * 3 = 36')).toBe('12 * 3 = 36');
  });

  it('текст без разметки проходит как есть', () => {
    const text = 'Здравствуйте! Срок готовности — до 28 августа, 14:00.';
    expect(toTelegramPlainText(text)).toBe(text);
  });
});
