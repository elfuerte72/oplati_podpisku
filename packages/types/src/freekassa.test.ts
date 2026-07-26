import { describe, expect, it } from 'vitest';

import {
  freekassaCreateOrderResponseSchema,
  freekassaNotificationSchema,
  kopecksToRubleAmount,
  maskPayerAccount,
  parseRubleAmountToKopecks,
  toStorableNotification,
} from './freekassa.ts';

describe('parseRubleAmountToKopecks', () => {
  it('разбирает целые и дробные суммы точно', () => {
    expect(parseRubleAmountToKopecks('2490')).toBe(249_000);
    expect(parseRubleAmountToKopecks('2490.5')).toBe(249_050);
    expect(parseRubleAmountToKopecks('2490.50')).toBe(249_050);
    expect(parseRubleAmountToKopecks('0.01')).toBe(1);
    expect(parseRubleAmountToKopecks(' 100.00 ')).toBe(10_000);
  });

  it('принимает запятую как разделитель дробной части', () => {
    expect(parseRubleAmountToKopecks('2490,50')).toBe(249_050);
  });

  it('переживает лишние НУЛИ сверх двух знаков', () => {
    expect(parseRubleAmountToKopecks('2490.5000')).toBe(249_050);
    expect(parseRubleAmountToKopecks('2490.000')).toBe(249_000);
  });

  it('НЕ округляет дробь мельче копейки — отвергает', () => {
    // Молча округлить значило бы придумать/потерять деньги; такую сумму должен
    // разбирать оператор, а не эвристика.
    expect(parseRubleAmountToKopecks('2490.505')).toBeNull();
    expect(parseRubleAmountToKopecks('0.001')).toBeNull();
  });

  it('отвергает мусор, отрицательные, разделители тысяч и экспоненту', () => {
    expect(parseRubleAmountToKopecks('')).toBeNull();
    expect(parseRubleAmountToKopecks('abc')).toBeNull();
    expect(parseRubleAmountToKopecks('-100')).toBeNull();
    expect(parseRubleAmountToKopecks('1 000.00')).toBeNull();
    expect(parseRubleAmountToKopecks('1,000.00')).toBeNull();
    expect(parseRubleAmountToKopecks('1e3')).toBeNull();
    expect(parseRubleAmountToKopecks('100.')).toBeNull();
  });

  it('не теряет точность там, где её теряет parseFloat', () => {
    // parseFloat('2490.55') * 100 === 249054.99999999997 — именно ради этого
    // случая разбор целочисленный (инвариант 3).
    expect(parseRubleAmountToKopecks('2490.55')).toBe(249_055);
    expect(parseRubleAmountToKopecks('1234.35')).toBe(123_435);
  });
});

describe('kopecksToRubleAmount', () => {
  it('переводит копейки в рубли', () => {
    expect(kopecksToRubleAmount(249_000)).toBe(2490);
    expect(kopecksToRubleAmount(249_050)).toBe(2490.5);
  });

  it('строковая форма числа одинакова в JSON и в подписываемой строке', () => {
    // Инвариант подписи: HMAC считается по String(value), а в тело уходит
    // JSON.stringify(value). Разойдутся — провайдер отвергнет каждый запрос.
    for (const kopecks of [249_000, 249_050, 249_055, 100, 50_000]) {
      const amount = kopecksToRubleAmount(kopecks);
      expect(String(amount)).toBe(JSON.stringify(amount));
    }
  });

  it('отвергает нецелые и неположительные копейки', () => {
    expect(() => kopecksToRubleAmount(0)).toThrow();
    expect(() => kopecksToRubleAmount(-1)).toThrow();
    expect(() => kopecksToRubleAmount(10.5)).toThrow();
  });
});

describe('freekassaCreateOrderResponseSchema', () => {
  it('принимает orderId и числом, и строкой (нормализует в строку)', () => {
    const asNumber = freekassaCreateOrderResponseSchema.parse({
      type: 'success',
      orderId: 123,
      orderHash: 'bd4161db429848651499aabcb1d89330',
      location: 'https://pay.freekassa.ru/form/123/bd4161db429848651499aabcb1d89330',
    });
    expect(asNumber.orderId).toBe('123');

    const asString = freekassaCreateOrderResponseSchema.parse({
      type: 'success',
      orderId: '123',
      orderHash: 'h',
      location: 'https://pay.freekassa.ru/form/123/h',
    });
    expect(asString.orderId).toBe('123');
  });

  it('падает на ответе без ссылки на оплату', () => {
    expect(() =>
      freekassaCreateOrderResponseSchema.parse({
        type: 'success',
        orderId: 1,
        orderHash: 'h',
      }),
    ).toThrow();
  });
});

describe('freekassaNotificationSchema', () => {
  const base = {
    MERCHANT_ID: '777',
    AMOUNT: '2490.50',
    intid: '999',
    MERCHANT_ORDER_ID: 'ORD-S3MGS-a1b2c3',
    SIGN: 'deadbeef',
  };

  it('пропускает неизвестные поля (us_*, новые поля провайдера)', () => {
    const parsed = freekassaNotificationSchema.parse({ ...base, us_foo: 'bar' });
    expect(parsed).toMatchObject({ intid: '999' });
  });

  it('требует поля, участвующие в подписи', () => {
    for (const key of ['MERCHANT_ID', 'AMOUNT', 'MERCHANT_ORDER_ID', 'SIGN', 'intid']) {
      const broken: Record<string, string> = { ...base };
      delete broken[key];
      expect(freekassaNotificationSchema.safeParse(broken).success).toBe(false);
    }
  });
});

describe('маскирование счёта плательщика', () => {
  it('оставляет только последние 4 символа', () => {
    expect(maskPayerAccount('4444444444444444')).toBe('****4444');
    expect(maskPayerAccount('12')).toBe('****');
    expect(maskPayerAccount(undefined)).toBeUndefined();
  });

  it('в сохраняемую нагрузку не попадают ни полный счёт, ни подпись', () => {
    const storable = toStorableNotification(
      freekassaNotificationSchema.parse({
        MERCHANT_ID: '777',
        AMOUNT: '100.00',
        intid: '999',
        MERCHANT_ORDER_ID: 'ORD-1-aaa',
        SIGN: 'deadbeef',
        payer_account: '4444444444444444',
      }),
    );
    const serialized = JSON.stringify(storable);
    expect(serialized).not.toContain('4444444444444444');
    expect(serialized).not.toContain('deadbeef');
    expect(storable.payer_account_masked).toBe('****4444');
    expect(storable.payer_account).toBeUndefined();
    expect(storable.SIGN).toBeUndefined();
  });
});
