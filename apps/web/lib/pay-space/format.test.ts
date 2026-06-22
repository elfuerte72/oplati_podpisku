import { describe, expect, it } from 'vitest';

import {
  cardFundingUsdCents,
  dollarStringToUsdCents,
  maskPan,
  parseExpDate,
  usdCentsToDollarString,
} from './format.ts';

describe('usdCentsToDollarString', () => {
  it('форматирует центы в доллары-строку', () => {
    expect(usdCentsToDollarString(1000)).toBe('10.00');
    expect(usdCentsToDollarString(1050)).toBe('10.50');
    expect(usdCentsToDollarString(5)).toBe('0.05');
    expect(usdCentsToDollarString(0)).toBe('0.00');
    expect(usdCentsToDollarString(123456)).toBe('1234.56');
  });

  it('бросает на не-integer', () => {
    expect(() => usdCentsToDollarString(10.5)).toThrow();
  });
});

describe('dollarStringToUsdCents', () => {
  it('парсит доллары-строку в центы', () => {
    expect(dollarStringToUsdCents('10')).toBe(1000);
    expect(dollarStringToUsdCents('10.00')).toBe(1000);
    expect(dollarStringToUsdCents('10.5')).toBe(1050);
    expect(dollarStringToUsdCents('0.05')).toBe(5);
    expect(dollarStringToUsdCents('1234.56')).toBe(123456);
  });

  it('принимает число (card.balance приходит числом)', () => {
    expect(dollarStringToUsdCents(1.0)).toBe(100);
    expect(dollarStringToUsdCents(18.43)).toBe(1843);
    expect(dollarStringToUsdCents(0)).toBe(0);
  });

  it('round-trip с центами', () => {
    for (const cents of [0, 1, 5, 99, 100, 1050, 49999]) {
      expect(dollarStringToUsdCents(usdCentsToDollarString(cents))).toBe(cents);
    }
  });

  it('округляет к ближайшему центу при 3+ знаках после точки (без fp-дрейфа)', () => {
    expect(dollarStringToUsdCents('114.145')).toBe(11415); // .145 → округление вверх
    expect(dollarStringToUsdCents('10.994')).toBe(1099); // .4 → вниз
    expect(dollarStringToUsdCents('10.995')).toBe(1100); // .5 → вверх
    expect(dollarStringToUsdCents('1.005')).toBe(101); // классический fp-кейс
  });

  it('бросает на мусоре и научной нотации', () => {
    expect(() => dollarStringToUsdCents('abc')).toThrow();
    expect(() => dollarStringToUsdCents('1e2')).toThrow();
    expect(() => dollarStringToUsdCents('')).toThrow();
  });
});

describe('cardFundingUsdCents', () => {
  it('буфер 0% — сумма ровно равна цене (прежнее поведение)', () => {
    expect(cardFundingUsdCents(2000, 0)).toBe(2000);
    expect(cardFundingUsdCents(10000, 0)).toBe(10000);
  });

  it('буфер 20% — добавляет запас, округляя ВВЕРХ', () => {
    expect(cardFundingUsdCents(2000, 20)).toBe(2400); // $20.00 → $24.00
    expect(cardFundingUsdCents(10000, 20)).toBe(12000); // $100 → $120 (покрывает +14% эстонский кейс)
    // 999 × 1.2 = 1198.8 → ceil → 1199 (никогда не недобираем)
    expect(cardFundingUsdCents(999, 20)).toBe(1199);
  });

  it('буфер 15% округляет вверх даже на дробном результате', () => {
    expect(cardFundingUsdCents(101, 15)).toBe(117); // 101 × 1.15 = 116.15 → 117
  });

  it('бросает на невалидных входах', () => {
    expect(() => cardFundingUsdCents(20.5, 20)).toThrow(); // не integer
    expect(() => cardFundingUsdCents(-100, 20)).toThrow(); // отрицательная цена
    expect(() => cardFundingUsdCents(2000, -5)).toThrow(); // отрицательный буфер
  });
});

describe('maskPan', () => {
  it('маскирует середину, оставляя 6+4', () => {
    expect(maskPan('5395020388220113')).toBe('539502******0113');
    expect(maskPan('4111111111111111')).toBe('411111******1111');
  });

  it('короткие/нечисловые маскирует целиком (не утечь PAN)', () => {
    expect(maskPan('123')).toBe('****');
    expect(maskPan('')).toBe('****');
  });
});

describe('parseExpDate', () => {
  it('парсит YYYY-MM-DD (как в доке)', () => {
    expect(parseExpDate('2027-01-20')).toEqual({ expMonth: 1, expYear: 2027 });
    expect(parseExpDate('2026-12-31')).toEqual({ expMonth: 12, expYear: 2026 });
  });

  it('парсит MM/YY (реальный ответ create/info)', () => {
    expect(parseExpDate('06/27')).toEqual({ expMonth: 6, expYear: 2027 });
    expect(parseExpDate('01/30')).toEqual({ expMonth: 1, expYear: 2030 });
  });

  it('бросает на неизвестном формате', () => {
    expect(() => parseExpDate('27-06')).toThrow();
    expect(() => parseExpDate('garbage')).toThrow();
  });
});
