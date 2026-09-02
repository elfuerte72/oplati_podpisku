import { describe, expect, it } from 'vitest';

import { ANALYTICS_PERIODS, parsePeriod, periodBounds, periodHref } from './period';

/**
 * Период раздела «Аналитика» живёт в адресе (`?period=7|30|90`) и разбирается
 * как граница (инвариант 5): мусор откатывается к значению по умолчанию, а не
 * роняет страницу и не показывает «всё».
 */
describe('parsePeriod', () => {
  it('принимает три допустимых значения', () => {
    expect(parsePeriod({ period: '7' })).toBe(7);
    expect(parsePeriod({ period: '30' })).toBe(30);
    expect(parsePeriod({ period: '90' })).toBe(90);
  });

  it('мусор, пустота и массив → 30 по умолчанию, без ошибки', () => {
    expect(parsePeriod({})).toBe(30);
    expect(parsePeriod({ period: '' })).toBe(30);
    expect(parsePeriod({ period: '365' })).toBe(30);
    expect(parsePeriod({ period: 'abc' })).toBe(30);
    expect(parsePeriod({ period: ['7', '90'] })).toBe(7);
  });

  it('список периодов — единственный источник допустимых значений', () => {
    expect(ANALYTICS_PERIODS).toEqual([7, 30, 90]);
  });
});

describe('periodBounds', () => {
  const now = new Date('2026-09-02T13:45:00.000Z');

  it('90 дней: начало — сегодня минус 89 дней, полночь UTC; конец — начало завтрашнего дня', () => {
    const b = periodBounds(90, now);
    expect(b.since.toISOString()).toBe('2026-06-05T00:00:00.000Z');
    expect(b.until.toISOString()).toBe('2026-09-03T00:00:00.000Z');
    expect(b.days).toBe(90);
  });

  it('7 дней включают сегодняшний день целиком', () => {
    const b = periodBounds(7, now);
    expect(b.since.toISOString()).toBe('2026-08-27T00:00:00.000Z');
    expect(b.until.toISOString()).toBe('2026-09-03T00:00:00.000Z');
    expect(b.days).toBe(7);
  });

  it('границы считаются по UTC, а не по часовому поясу сервера: 23:59 UTC — тот же день', () => {
    const late = new Date('2026-09-02T23:59:59.999Z');
    expect(periodBounds(30, late).since.toISOString()).toBe('2026-08-04T00:00:00.000Z');
  });
});

describe('periodHref', () => {
  it('собирает адрес раздела с периодом', () => {
    expect(periodHref('/admin/analytics', 7)).toBe('/admin/analytics?period=7');
  });
});
