import { describe, expect, it } from 'vitest';

import { normalizeEmail } from './email.ts';

describe('normalizeEmail (плашка контактов, тикет 02)', () => {
  it('валидный адрес проходит, пробелы по краям срезаются', () => {
    expect(normalizeEmail('  client@example.com ')).toBe('client@example.com');
  });

  it('мусор и пустота — null', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('не почта')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail('@example.com')).toBeNull();
    // Суррогат старой схемы валиден по формату — это ок: гейт различает
    // источник (users.email), а не форму адреса.
    expect(normalizeEmail(`x${'a'.repeat(260)}@example.com`)).toBeNull();
  });
});
