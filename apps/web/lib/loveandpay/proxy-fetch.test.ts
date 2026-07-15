import { describe, expect, it } from 'vitest';

import { buildProxyFetch, proxyHostForLog } from './proxy-fetch.ts';

describe('buildProxyFetch', () => {
  it('возвращает функцию для валидного proxy-URL', () => {
    const f = buildProxyFetch('http://user:pass@203.0.113.10:24128');
    expect(typeof f).toBe('function');
  });

  it('бросает на невалидном URL (fail-fast при инициализации клиента)', () => {
    expect(() => buildProxyFetch('не-урл')).toThrow();
  });
});

describe('proxyHostForLog', () => {
  it('отдаёт host:port без credentials', () => {
    const s = proxyHostForLog('http://user:secretpass@203.0.113.10:24128');
    expect(s).toBe('203.0.113.10:24128');
    expect(s).not.toContain('secretpass');
    expect(s).not.toContain('user');
  });
});
