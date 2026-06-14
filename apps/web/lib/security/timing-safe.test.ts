import { describe, expect, it } from 'vitest';

import { timingSafeEqualStr } from './timing-safe.ts';

describe('timingSafeEqualStr', () => {
  it('равные строки → true', () => {
    expect(timingSafeEqualStr('s3cr3t-token', 's3cr3t-token')).toBe(true);
  });

  it('разные строки той же длины → false', () => {
    expect(timingSafeEqualStr('aaaaaaaa', 'aaaaaaab')).toBe(false);
  });

  it('разная длина → false (без исключения)', () => {
    expect(timingSafeEqualStr('short', 'a-much-longer-secret')).toBe(false);
    expect(timingSafeEqualStr('', 'x')).toBe(false);
  });

  it('обе пустые → true', () => {
    expect(timingSafeEqualStr('', '')).toBe(true);
  });

  it('юникод сравнивается корректно', () => {
    expect(timingSafeEqualStr('ключ-🔑', 'ключ-🔑')).toBe(true);
    expect(timingSafeEqualStr('ключ-🔑', 'ключ-🔒')).toBe(false);
  });
});
