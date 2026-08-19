import { describe, expect, it } from 'vitest';

import { isPriceLockExpired, priceLockMinutesLeft } from './expiry.ts';

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

describe('priceLockMinutesLeft', () => {
  const NOW = new Date('2026-08-19T12:00:00Z');
  const inMinutes = (m: number) => new Date(NOW.getTime() + m * 60_000);

  it('называет реальный остаток фиксации, а не зашитое число', () => {
    // Клиенту, которого развернул preflight, обещать «цена держится 2 часа»
    // нельзя: у его заказа могло остаться десять минут.
    expect(priceLockMinutesLeft({ expiresAt: inMinutes(43) }, NOW)).toBe(43);
  });

  it('неполная минута считается в пользу клиента — вверх', () => {
    expect(priceLockMinutesLeft({ expiresAt: new Date(NOW.getTime() + 90_000) }, NOW)).toBe(2);
  });

  it('срока нет — говорить нечего', () => {
    expect(priceLockMinutesLeft({ expiresAt: null }, NOW)).toBeNull();
  });

  it('срок прошёл — не отрицательное число, а «нечего сказать»', () => {
    expect(priceLockMinutesLeft({ expiresAt: inMinutes(-5) }, NOW)).toBeNull();
  });
});
