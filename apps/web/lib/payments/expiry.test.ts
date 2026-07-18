import { describe, expect, it } from 'vitest';

import { isPriceLockExpired } from './expiry.ts';

const NOW = new Date('2026-07-18T12:00:00Z');
const PAST = new Date('2026-07-18T11:59:59Z');
const FUTURE = new Date('2026-07-18T12:00:01Z');

describe('isPriceLockExpired (гейт H-2: фиксация цены форсится сервером)', () => {
  it('ready_for_payment с истёкшим expiresAt → true', () => {
    expect(isPriceLockExpired({ status: 'ready_for_payment', expiresAt: PAST }, NOW)).toBe(true);
  });

  it('ready_for_payment с живым expiresAt → false', () => {
    expect(isPriceLockExpired({ status: 'ready_for_payment', expiresAt: FUTURE }, NOW)).toBe(
      false,
    );
  });

  it('граница: expiresAt === now → ещё не истёк (симметрия с SQL `< now()` в cron)', () => {
    expect(isPriceLockExpired({ status: 'ready_for_payment', expiresAt: NOW }, NOW)).toBe(false);
  });

  it('expiresAt IS NULL → false (без фиксации нечего форсить)', () => {
    expect(isPriceLockExpired({ status: 'ready_for_payment', expiresAt: null }, NOW)).toBe(false);
  });

  it('не-ready_for_payment статусы → false (pending_payment живёт по TTL инвойса)', () => {
    expect(isPriceLockExpired({ status: 'pending_payment', expiresAt: PAST }, NOW)).toBe(false);
    expect(isPriceLockExpired({ status: 'draft', expiresAt: PAST }, NOW)).toBe(false);
  });
});
