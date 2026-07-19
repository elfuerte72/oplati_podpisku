import { describe, expect, it } from 'vitest';

import { parseCustomAmountUsd } from './amount.ts';

// Обычный сервис (потолок $500) и высоколимитный (Airbnb/Booking/Steam, до $5000).
const NORMAL = 'spotify-premium';
const HIGH_VALUE = 'airbnb';

describe('parseCustomAmountUsd', () => {
  it('целое число в диапазоне → ok с центами', () => {
    expect(parseCustomAmountUsd('120', NORMAL)).toEqual({ kind: 'ok', usdCents: 12_000 });
  });

  it('дробь через точку → ok с округлением до центов', () => {
    expect(parseCustomAmountUsd('19.99', NORMAL)).toEqual({ kind: 'ok', usdCents: 1999 });
  });

  it('дробь через запятую → ok', () => {
    expect(parseCustomAmountUsd('19,99', NORMAL)).toEqual({ kind: 'ok', usdCents: 1999 });
  });

  it('префикс $ и пробелы игнорируются', () => {
    expect(parseCustomAmountUsd('  $120 ', NORMAL)).toEqual({ kind: 'ok', usdCents: 12_000 });
  });

  it('границы $1 и $500 включительно → ok', () => {
    expect(parseCustomAmountUsd('1', NORMAL)).toEqual({ kind: 'ok', usdCents: 100 });
    expect(parseCustomAmountUsd('500', NORMAL)).toEqual({ kind: 'ok', usdCents: 50_000 });
  });

  it('меньше $1 → invalid', () => {
    expect(parseCustomAmountUsd('0.5', NORMAL)).toEqual({ kind: 'invalid' });
    expect(parseCustomAmountUsd('0', NORMAL)).toEqual({ kind: 'invalid' });
  });

  it('больше $500 для обычного сервиса → invalid', () => {
    expect(parseCustomAmountUsd('501', NORMAL)).toEqual({ kind: 'invalid' });
    expect(parseCustomAmountUsd('99999', NORMAL)).toEqual({ kind: 'invalid' });
  });

  it('число с лишним текстом → invalid (строгий разбор всей строки)', () => {
    // "120 долларов" не должно проходить как ok — но это явная попытка суммы,
    // поэтому переспрашиваем (invalid), а не уходим в агента.
    expect(parseCustomAmountUsd('120 долларов', NORMAL)).toEqual({ kind: 'invalid' });
  });

  it('отрицательное число → invalid', () => {
    expect(parseCustomAmountUsd('-50', NORMAL)).toEqual({ kind: 'invalid' });
  });

  it('текст без цифр → not_amount (смена намерения → агент)', () => {
    expect(parseCustomAmountUsd('оператор', NORMAL)).toEqual({ kind: 'not_amount' });
    expect(parseCustomAmountUsd('отмена', NORMAL)).toEqual({ kind: 'not_amount' });
    expect(parseCustomAmountUsd('привет', NORMAL)).toEqual({ kind: 'not_amount' });
  });

  it('текст с числом-намерением → invalid, не ok (защита от «оплати 5 подписок»)', () => {
    // Содержит цифру → не not_amount; не парсится как чистое число → invalid.
    // Главное: НЕ создаём заказ на $5.
    const r = parseCustomAmountUsd('оплати 5 подписок', NORMAL);
    expect(r.kind).not.toBe('ok');
  });
});

describe('parseCustomAmountUsd — запятая-разделитель тысяч (M-5 аудита)', () => {
  it('«1,000» — разделитель тысяч, НЕ $1', () => {
    expect(parseCustomAmountUsd('1,000', HIGH_VALUE)).toEqual({ kind: 'ok', usdCents: 100_000 });
    // Для обычного сервиса $1000 выше потолка $500 → invalid (переспросить),
    // но ни в коем случае НЕ ok на $1.
    expect(parseCustomAmountUsd('1,000', NORMAL)).toEqual({ kind: 'invalid' });
  });

  it('«2,500» для высоколимитного → $2500', () => {
    expect(parseCustomAmountUsd('2,500', HIGH_VALUE)).toEqual({ kind: 'ok', usdCents: 250_000 });
  });

  it('«1,000.50» — тысячи + десятичная точка', () => {
    expect(parseCustomAmountUsd('1,000.50', HIGH_VALUE)).toEqual({ kind: 'ok', usdCents: 100_050 });
  });

  it('«1,5» остаётся десятичной дробью', () => {
    expect(parseCustomAmountUsd('1,5', NORMAL)).toEqual({ kind: 'ok', usdCents: 150 });
  });

  it('«1,00» — двусмысленно (обрубленные тысячи?) → invalid, переспросить', () => {
    expect(parseCustomAmountUsd('1,00', NORMAL)).toEqual({ kind: 'invalid' });
  });

  it('«1.000,50» (европейский формат) → invalid, не misparse', () => {
    expect(parseCustomAmountUsd('1.000,50', HIGH_VALUE)).toEqual({ kind: 'invalid' });
  });
});

describe('parseCustomAmountUsd — высоколимитные сервисы (до $5000)', () => {
  it('сумма >$500 проходит для Airbnb/Booking', () => {
    expect(parseCustomAmountUsd('610', HIGH_VALUE)).toEqual({ kind: 'ok', usdCents: 61_000 });
    expect(parseCustomAmountUsd('5000', 'booking')).toEqual({ kind: 'ok', usdCents: 500_000 });
  });

  it('граница $5000 включительно → ok, выше → invalid', () => {
    expect(parseCustomAmountUsd('5000', HIGH_VALUE)).toEqual({ kind: 'ok', usdCents: 500_000 });
    expect(parseCustomAmountUsd('5001', HIGH_VALUE)).toEqual({ kind: 'invalid' });
  });

  it('обычный сервис на той же сумме всё равно режется на $500', () => {
    expect(parseCustomAmountUsd('610', NORMAL)).toEqual({ kind: 'invalid' });
  });
});
