import { describe, expect, it } from 'vitest';

import { addOneMonthUtc, isUnlimitedExpiry, subscriptionExpiry } from './period.ts';

describe('subscriptionExpiry (срок подписки из настройки)', () => {
  const now = new Date('2026-07-29T12:00:00.000Z');

  it('0 месяцев = без ограничения, и это распознаётся как безлимит', () => {
    const expiry = subscriptionExpiry(now, 0);
    expect(isUnlimitedExpiry(expiry)).toBe(true);
    expect(expiry.getUTCFullYear()).toBe(2037);
  });

  it('срок фиксированный, а не «сейчас + N лет» — иначе PATCH на каждое нажатие', () => {
    const a = subscriptionExpiry(new Date('2026-01-01T00:00:00.000Z'), 0);
    const b = subscriptionExpiry(new Date('2026-12-31T23:59:59.000Z'), 0);
    expect(a.getTime()).toBe(b.getTime());
  });

  it('не заходит за 2038 — Y2038 в чужом коде по пути к панели', () => {
    const y2038 = Date.UTC(2038, 0, 19);
    expect(subscriptionExpiry(now, 0).getTime()).toBeLessThan(y2038);
  });

  it('N месяцев считается календарно, с клампом конца месяца', () => {
    expect(subscriptionExpiry(new Date('2026-01-31T10:00:00.000Z'), 1).toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
    expect(subscriptionExpiry(new Date('2026-01-31T10:00:00.000Z'), 3).toISOString()).toBe(
      '2026-04-30T10:00:00.000Z',
    );
  });

  it('срочный срок безлимитом НЕ считается', () => {
    expect(isUnlimitedExpiry(subscriptionExpiry(now, 1))).toBe(false);
    expect(isUnlimitedExpiry(subscriptionExpiry(now, 120))).toBe(false);
    expect(isUnlimitedExpiry(new Date('2026-06-01T00:00:00.000Z'))).toBe(false);
  });
});

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
