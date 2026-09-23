import { describe, expect, it } from 'vitest';

import {
  DOSSIER_DATES_MAX,
  DOSSIER_FACTS_MAX,
  DOSSIER_NUMBERS_MAX,
  DossierSchema,
} from './schemas.ts';

function dossier(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Google открыла память Gemini бесплатным пользователям',
    facts: [{ statement: 'Память включена всем', quote: 'memory is now available to all users' }],
    reader_new: 'Не нужно каждый раз напоминать о себе',
    works_in_russia: 'unknown',
    how_to_pay: 'unknown',
    ...overrides,
  };
}

function facts(count: number): { statement: string; quote: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    statement: `Факт ${index + 1}`,
    quote: `quote ${index + 1}`,
  }));
}

describe('DossierSchema', () => {
  // Регресс 23.09.2026: модель дважды вернула больше восьми фактов, и шаг
  // падал с «facts: Array must contain at most 8 element(s)».
  it('лишние факты отрезаются, а не роняют шаг: остаются первые', () => {
    const parsed = DossierSchema.safeParse(dossier({ facts: facts(DOSSIER_FACTS_MAX + 3) }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.facts).toHaveLength(DOSSIER_FACTS_MAX);
    expect(parsed.data.facts[0]?.statement).toBe('Факт 1');
    expect(parsed.data.facts.at(-1)?.statement).toBe(`Факт ${DOSSIER_FACTS_MAX}`);
  });

  it('битый элемент в отрезаемом хвосте не валит досье', () => {
    const list = [...facts(DOSSIER_FACTS_MAX + 1), { statement: '', quote: '' }];
    const parsed = DossierSchema.safeParse(dossier({ facts: list }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.facts).toHaveLength(DOSSIER_FACTS_MAX);
  });

  it('битый элемент ВНУТРИ потолка по-прежнему отказ', () => {
    const list = [{ statement: '', quote: '' }, ...facts(3)];
    expect(DossierSchema.safeParse(dossier({ facts: list })).success).toBe(false);
  });

  it('досье без единого факта по-прежнему не принимается', () => {
    expect(DossierSchema.safeParse(dossier({ facts: [] })).success).toBe(false);
  });

  it('числа и даты сверх потолка тоже отрезаются', () => {
    const numbers = Array.from({ length: DOSSIER_NUMBERS_MAX + 4 }, (_, index) => ({
      value: String(index),
      what: 'что-то',
    }));
    const dates = Array.from({ length: DOSSIER_DATES_MAX + 2 }, (_, index) => ({
      date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      what: 'событие',
    }));
    const parsed = DossierSchema.safeParse(dossier({ numbers, dates }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.numbers).toHaveLength(DOSSIER_NUMBERS_MAX);
    expect(parsed.data.dates).toHaveLength(DOSSIER_DATES_MAX);
  });

  it('без чисел и дат — пустые списки', () => {
    const parsed = DossierSchema.safeParse(dossier());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.numbers).toEqual([]);
    expect(parsed.data.dates).toEqual([]);
  });
});
