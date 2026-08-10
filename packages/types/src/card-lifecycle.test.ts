import { describe, expect, it } from 'vitest';

import { CARD_LIFETIME_DAYS, CARD_TOPUP_SAFETY_DAYS, isCardTopupSafe } from './card-lifecycle.ts';

const dayMs = 24 * 60 * 60 * 1000;
const ageDays = (days: number, now: Date) => new Date(now.getTime() - days * dayMs);

/**
 * Запас перед концом жизни карты (аудит 2026-08-10, HIGH): долив на исходе
 * срока уходит на наш VCC при ближайшем `recycle-cards`, а клиент остаётся без
 * оплаченной подписки.
 */
describe('isCardTopupSafe', () => {
  const now = new Date('2026-08-11T00:00:00.000Z');

  it('карта в последние сутки жизни доливу не подлежит', () => {
    expect(isCardTopupSafe(ageDays(179.5, now), now)).toBe(false);
    expect(isCardTopupSafe(ageDays(200, now), now)).toBe(false);
  });

  it('карта моложе порога доливается', () => {
    expect(isCardTopupSafe(ageDays(178.9, now), now)).toBe(true);
    expect(isCardTopupSafe(ageDays(1, now), now)).toBe(true);
  });

  it('граница ровно на CARD_LIFETIME_DAYS - CARD_TOPUP_SAFETY_DAYS', () => {
    const boundary = CARD_LIFETIME_DAYS - CARD_TOPUP_SAFETY_DAYS;
    expect(isCardTopupSafe(ageDays(boundary, now), now)).toBe(true);
    expect(isCardTopupSafe(new Date(ageDays(boundary, now).getTime() - 1), now)).toBe(false);
  });

  it('запас строго меньше срока жизни — иначе доливать было бы нечего', () => {
    expect(CARD_TOPUP_SAFETY_DAYS).toBeGreaterThan(0);
    expect(CARD_TOPUP_SAFETY_DAYS).toBeLessThan(CARD_LIFETIME_DAYS);
  });
});
