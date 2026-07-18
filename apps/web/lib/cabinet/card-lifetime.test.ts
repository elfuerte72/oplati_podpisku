import { describe, expect, it } from 'vitest';

import { cardValidUntil } from './read';
import { CARD_LIFETIME_DAYS } from './types';

describe('cardValidUntil', () => {
  it('срок действия = дата выпуска + 180 дней (пример из ТЗ: 12.07.2026 → 08.01.2027)', () => {
    expect(CARD_LIFETIME_DAYS).toBe(180);
    expect(cardValidUntil(new Date('2026-07-12T10:00:00.000Z'))).toBe(
      '2027-01-08T10:00:00.000Z',
    );
  });
});
