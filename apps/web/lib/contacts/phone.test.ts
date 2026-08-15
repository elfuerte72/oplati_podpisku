import { describe, expect, it } from 'vitest';

import { normalizePhone, normalizeTelegramPhone } from './phone.ts';

describe('normalizePhone (телефон от 10 000 ₽, тикет 05)', () => {
  it('российские варианты приводятся к +7...', () => {
    // RU-приоритет (основная аудитория): 8..., 7..., голые 10 цифр с 9.
    expect(normalizePhone('8 999 123-45-67')).toBe('+79991234567');
    expect(normalizePhone('79991234567')).toBe('+79991234567');
    expect(normalizePhone('+7 (999) 123 45 67')).toBe('+79991234567');
    expect(normalizePhone('9991234567')).toBe('+79991234567');
  });

  it('не-РФ номера в E.164 проходят как есть', () => {
    // Клиент может жить не в РФ (спека §4.2) — только +7 было бы неправильно.
    expect(normalizePhone('+995 599 12 34 56')).toBe('+995599123456');
    expect(normalizePhone('+1 415 555 0100')).toBe('+14155550100');
  });

  it('normalizeTelegramPhone: контакт Telegram уже с кодом страны, «+» дописывается', () => {
    // Telegram отдаёт phone_number то с плюсом, то без — код страны в нём есть.
    expect(normalizeTelegramPhone('79991234567')).toBe('+79991234567');
    expect(normalizeTelegramPhone('+79991234567')).toBe('+79991234567');
    expect(normalizeTelegramPhone('4915123456789')).toBe('+4915123456789');
    expect(normalizeTelegramPhone('')).toBeNull();
  });

  it('мусор, короткие и сверхдлинные — null', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('не номер')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    // E.164 максимум 15 цифр.
    expect(normalizePhone('+1234567890123456')).toBeNull();
    // 11 цифр без префикса РФ и без + — непонятно чей, не угадываем.
    expect(normalizePhone('19991234567')).toBeNull();
  });
});
