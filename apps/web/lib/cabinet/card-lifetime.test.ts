import { describe, expect, it } from 'vitest';

import { cardValidUntil } from './read';
import { CARD_LIFETIME_DAYS } from './types';

describe('cardValidUntil', () => {
  it('без live-данных: дата выпуска + 180 дней (пример из ТЗ: 12.07.2026 → 08.01.2027)', () => {
    expect(CARD_LIFETIME_DAYS).toBe(180);
    expect(cardValidUntil(new Date('2026-07-12T10:00:00.000Z'))).toBe(
      '2027-01-08T10:00:00.000Z',
    );
  });

  it('реальный exp_date карты (MM/YY из PaySpace) приоритетнее расчётного (L-10)', () => {
    expect(cardValidUntil(new Date('2026-07-12T10:00:00.000Z'), '09/27')).toBe(
      '2027-09-30T23:59:59.000Z',
    );
    // Февраль — правильный конец месяца.
    expect(cardValidUntil(new Date('2026-07-12T10:00:00.000Z'), '02/28')).toBe(
      '2028-02-29T23:59:59.000Z',
    );
  });

  it('кривой exp_date → fallback на расчётные 180 дней', () => {
    expect(cardValidUntil(new Date('2026-07-12T10:00:00.000Z'), '13/27')).toBe(
      '2027-01-08T10:00:00.000Z',
    );
    expect(cardValidUntil(new Date('2026-07-12T10:00:00.000Z'), '2027-09-30')).toBe(
      '2027-01-08T10:00:00.000Z',
    );
  });
});
