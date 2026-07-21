import { describe, expect, it } from 'vitest';

import { addOneMonthUtc } from './period.ts';

describe('addOneMonthUtc (срок VPN-подписки «ровно месяц»)', () => {
  it('обычная дата → тот же день следующего месяца', () => {
    expect(addOneMonthUtc(new Date('2026-07-21T15:00:00.000Z')).toISOString()).toBe(
      '2026-08-21T15:00:00.000Z',
    );
  });

  it('конец месяца клампится (31 января → 28 февраля, не «3 марта»)', () => {
    expect(addOneMonthUtc(new Date('2026-01-31T10:00:00.000Z')).toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
  });

  it('високосный февраль: 31 января 2028 → 29 февраля', () => {
    expect(addOneMonthUtc(new Date('2028-01-31T10:00:00.000Z')).toISOString()).toBe(
      '2028-02-29T10:00:00.000Z',
    );
  });

  it('декабрь переходит через год', () => {
    expect(addOneMonthUtc(new Date('2026-12-15T00:00:00.000Z')).toISOString()).toBe(
      '2027-01-15T00:00:00.000Z',
    );
  });
});
