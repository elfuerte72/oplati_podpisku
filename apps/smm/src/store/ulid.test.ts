import { describe, expect, it } from 'vitest';

import { ulid, ulidTime } from './ulid.ts';

describe('ulid', () => {
  it('26 знаков из алфавита Крокфорда', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('несёт время создания', () => {
    const at = Date.UTC(2026, 8, 22, 12, 0, 0);
    expect(ulidTime(ulid(at))).toBe(at);
  });

  it('сортируется как строка по времени', () => {
    const early = ulid(Date.UTC(2026, 0, 1));
    const late = ulid(Date.UTC(2026, 8, 22));
    expect(early < late).toBe(true);
  });

  it('два id в одну миллисекунду не равны и сохраняют порядок', () => {
    // Иначе два решения, записанных в один тик, лягут в журнал в случайном
    // порядке, и «approve после previewed» станет неразличимым.
    const at = Date.UTC(2026, 8, 22, 12, 0, 0);
    const ids = [ulid(at), ulid(at), ulid(at)];
    expect(new Set(ids).size).toBe(3);
    expect([...ids].sort()).toEqual(ids);
  });

  it('тысяча id подряд уникальна', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(ids.size).toBe(1000);
  });

  it('разбор не-ULID бросает', () => {
    expect(() => ulidTime('не-ulid!!!')).toThrowError(/не ULID/);
  });
});
