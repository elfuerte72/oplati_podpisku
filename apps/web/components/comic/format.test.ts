import { describe, expect, it } from 'vitest';

import { formatDeadlineWithYear, formatExpires } from './format';

/**
 * Регресс на находку владельца 2026-07-30: кабинет показывал «Действует до
 * 30 июня в 23:59» у карты со сроком до июня 2030 — год не выводился, и дата
 * читалась как прошлый месяц. Сроки, до которых месяцы, обязаны нести год.
 */
describe('formatDeadlineWithYear', () => {
  it('выводит год — иначе далёкая дата читается как прошедшая', () => {
    const out = formatDeadlineWithYear('2030-06-30T20:59:59.000Z');
    expect(out).toContain('2030');
    expect(out).toContain('июня');
    expect(out).toContain('30');
  });

  it('рендерит в московском времени: 20:59:59 UTC = 23:59 того же дня', () => {
    const out = formatDeadlineWithYear('2026-12-22T20:59:59.000Z');
    expect(out).toContain('23:59');
    expect(out).toContain('22');
    expect(out).toContain('декабря');
    // Не «23 декабря»: сдвиг в следующий день был бы ошибкой часового пояса.
    expect(out).not.toContain('23 декабря');
  });

  /**
   * `new Date('мусор').toLocaleString()` не бросает, а возвращает «Invalid Date»,
   * поэтому одного try/catch мало — строку-заглушку показали бы клиенту.
   */
  it('мусор возвращается как есть, а не превращается в «Invalid Date»', () => {
    expect(formatDeadlineWithYear('не-дата')).toBe('не-дата');
    expect(formatExpires('не-дата')).toBe('не-дата');
  });

  /**
   * `new Date('2026-02-30')` не отвергается движком, а нормализуется во 2 марта.
   * Показать клиенту выдуманный срок хуже, чем показать сырую строку.
   */
  it('несуществующая календарная дата не превращается в соседнюю', () => {
    expect(formatDeadlineWithYear('2026-02-30T10:00:00.000Z')).toBe('2026-02-30T10:00:00.000Z');
    expect(formatDeadlineWithYear('2026-02-30')).toBe('2026-02-30');
    expect(formatExpires('2026-02-30T10:00:00.000Z')).toBe('2026-02-30T10:00:00.000Z');
  });

  /**
   * Обратная сторона той же проверки: у строки со смещением календарный день в
   * UTC законно отличается от написанного, и отвергать её нельзя.
   */
  it('дата со смещением часового пояса остаётся валидной', () => {
    const out = formatDeadlineWithYear('2026-12-22T01:00:00+03:00');
    expect(out).toContain('2026');
    expect(out).toContain('декабря');
    expect(out).not.toContain('+03:00');
  });
});

/**
 * `formatExpires` обслуживает срок счёта (живёт час) и фиксацию цены (два часа) —
 * там год избыточен. Проверяем, что разделение сохранилось: если однажды кто-то
 * добавит год сюда, подписи счетов станут шумными.
 */
describe('formatExpires', () => {
  it('года НЕ выводит — это формат для часовых сроков', () => {
    expect(formatExpires('2026-12-22T20:59:59.000Z')).not.toContain('2026');
  });

  it('показывает время и месяц в МСК', () => {
    const out = formatExpires('2026-12-22T20:59:59.000Z');
    expect(out).toContain('23:59');
    expect(out).toContain('декабря');
  });
});
