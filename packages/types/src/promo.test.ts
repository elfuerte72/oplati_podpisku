import { describe, expect, it } from 'vitest';

import { normalizePromoCode, promoCodeInputSchema, PROMO_CODE_MAX_LENGTH } from './promo.ts';

describe('normalizePromoCode', () => {
  it('поднимает регистр и обрезает пробелы', () => {
    expect(normalizePromoCode('  дарлинг  ')).toBe('ДАРЛИНГ');
  });

  it('латинские гомоглифы схлопываются в кириллицу', () => {
    // «ДAРЛИНГ» с ЛАТИНСКОЙ A — визуально неотличимо, и это тот же код.
    expect(normalizePromoCode('ДAРЛИНГ')).toBe('ДАРЛИНГ');
    expect(normalizePromoCode('дaрлинг')).toBe('ДАРЛИНГ');
    // Каждая буква таблицы по отдельности.
    expect(normalizePromoCode('ABEKMHOPCTXY')).toBe('АВЕКМНОРСТХУ');
  });

  it('внутренние пробелы и дефисы выбрасываются', () => {
    expect(normalizePromoCode('ДАР ЛИНГ')).toBe('ДАРЛИНГ');
    expect(normalizePromoCode('ДАР-ЛИНГ')).toBe('ДАРЛИНГ');
    expect(normalizePromoCode('ДАР_ЛИНГ')).toBe('ДАРЛИНГ');
  });

  it('латинский код тоже каноникализируется — и это ровно то, что нужно', () => {
    // ⚠️ «WINTER» превращается в «WINТЕR» (T и E — кириллические). Выглядит
    // странно, но работает: ту же функцию зовёт скрипт заведения кода, поэтому
    // в БД лежит ТА ЖЕ строка, и поиск сходится. Свойство, на котором всё
    // держится, — не «латиница сохраняется», а «любое написание одного кода
    // даёт один результат».
    expect(normalizePromoCode('winter')).toBe(normalizePromoCode('WINTER'));
    expect(normalizePromoCode('wintеr')).toBe(normalizePromoCode('WINTER'));
  });

  it('любые смеси раскладок одного кода сходятся в одну строку', () => {
    const variants = ['ДАРЛИНГ', 'дарлинг', 'ДAРЛИНГ', ' дaрлинг ', 'ДАР-ЛИНГ', 'дAр линг'];
    const normalized = new Set(variants.map(normalizePromoCode));
    expect(normalized.size).toBe(1);
    expect([...normalized][0]).toBe('ДАРЛИНГ');
  });

  it('идемпотентна: повторная нормализация ничего не меняет', () => {
    const once = normalizePromoCode('  дaр-линг ');
    expect(normalizePromoCode(once)).toBe(once);
  });
});

describe('promoCodeInputSchema', () => {
  it('отдаёт уже нормализованный код', () => {
    expect(promoCodeInputSchema.parse(' дaрлинг ')).toBe('ДАРЛИНГ');
  });

  it('строка из одних пробелов отвергается', () => {
    // Длина проверяется ПОСЛЕ нормализации: по исходной такой вход прошёл бы.
    expect(promoCodeInputSchema.safeParse('   ').success).toBe(false);
  });

  it('пустая строка отвергается', () => {
    expect(promoCodeInputSchema.safeParse('').success).toBe(false);
  });

  it('слишком длинный код отвергается', () => {
    expect(promoCodeInputSchema.safeParse('Д'.repeat(PROMO_CODE_MAX_LENGTH + 1)).success).toBe(
      false,
    );
  });

  it('код ровно предельной длины проходит', () => {
    expect(promoCodeInputSchema.safeParse('Д'.repeat(PROMO_CODE_MAX_LENGTH)).success).toBe(true);
  });

  it('длинный вход из дефисов, сжимающийся до годного кода, проходит', () => {
    // Нормализация выбрасывает разделители, поэтому «Д-А-Р-Л-И-Н-Г» короче
    // предела, хотя исходная строка длиннее самого кода.
    expect(promoCodeInputSchema.parse('Д-А-Р-Л-И-Н-Г')).toBe('ДАРЛИНГ');
  });
});
