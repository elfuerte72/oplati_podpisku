import { describe, expect, it } from 'vitest';

import {
  dollarStringToUsdCents,
  maskPan,
  parseExpDateYmd,
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

  it('round-trip с центами', () => {
    for (const cents of [0, 1, 5, 99, 100, 1050, 49999]) {
      expect(dollarStringToUsdCents(usdCentsToDollarString(cents))).toBe(cents);
    }
  });

  it('бросает на мусоре', () => {
    expect(() => dollarStringToUsdCents('abc')).toThrow();
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

describe('parseExpDateYmd', () => {
  it('парсит YYYY-MM-DD', () => {
    expect(parseExpDateYmd('2027-01-20')).toEqual({ expMonth: 1, expYear: 2027 });
    expect(parseExpDateYmd('2026-12-31')).toEqual({ expMonth: 12, expYear: 2026 });
  });

  it('бросает на ином формате', () => {
    expect(() => parseExpDateYmd('01/27')).toThrow();
  });
});
