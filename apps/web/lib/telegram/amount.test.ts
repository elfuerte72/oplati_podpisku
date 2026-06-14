import { describe, expect, it } from 'vitest';

import { parseCustomAmountUsd } from './amount.ts';

describe('parseCustomAmountUsd', () => {
  it('целое число в диапазоне → ok с центами', () => {
    expect(parseCustomAmountUsd('120')).toEqual({ kind: 'ok', usdCents: 12_000 });
  });

  it('дробь через точку → ok с округлением до центов', () => {
    expect(parseCustomAmountUsd('19.99')).toEqual({ kind: 'ok', usdCents: 1999 });
  });

  it('дробь через запятую → ok', () => {
    expect(parseCustomAmountUsd('19,99')).toEqual({ kind: 'ok', usdCents: 1999 });
  });

  it('префикс $ и пробелы игнорируются', () => {
    expect(parseCustomAmountUsd('  $120 ')).toEqual({ kind: 'ok', usdCents: 12_000 });
  });

  it('границы $1 и $500 включительно → ok', () => {
    expect(parseCustomAmountUsd('1')).toEqual({ kind: 'ok', usdCents: 100 });
    expect(parseCustomAmountUsd('500')).toEqual({ kind: 'ok', usdCents: 50_000 });
  });

  it('меньше $1 → invalid', () => {
    expect(parseCustomAmountUsd('0.5')).toEqual({ kind: 'invalid' });
    expect(parseCustomAmountUsd('0')).toEqual({ kind: 'invalid' });
  });

  it('больше $500 → invalid', () => {
    expect(parseCustomAmountUsd('501')).toEqual({ kind: 'invalid' });
    expect(parseCustomAmountUsd('99999')).toEqual({ kind: 'invalid' });
  });

  it('число с лишним текстом → invalid (строгий разбор всей строки)', () => {
    // "120 долларов" не должно проходить как ok — но это явная попытка суммы,
    // поэтому переспрашиваем (invalid), а не уходим в агента.
    expect(parseCustomAmountUsd('120 долларов')).toEqual({ kind: 'invalid' });
  });

  it('отрицательное число → invalid', () => {
    expect(parseCustomAmountUsd('-50')).toEqual({ kind: 'invalid' });
  });

  it('текст без цифр → not_amount (смена намерения → агент)', () => {
    expect(parseCustomAmountUsd('оператор')).toEqual({ kind: 'not_amount' });
    expect(parseCustomAmountUsd('отмена')).toEqual({ kind: 'not_amount' });
    expect(parseCustomAmountUsd('привет')).toEqual({ kind: 'not_amount' });
  });

  it('текст с числом-намерением → invalid, не ok (защита от «оплати 5 подписок»)', () => {
    // Содержит цифру → не not_amount; не парсится как чистое число → invalid.
    // Главное: НЕ создаём заказ на $5.
    const r = parseCustomAmountUsd('оплати 5 подписок');
    expect(r.kind).not.toBe('ok');
  });
});
