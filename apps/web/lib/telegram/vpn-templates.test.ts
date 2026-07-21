import { describe, expect, it } from 'vitest';

import { buildVpnMessageHtml } from './templates';

const URL = 'https://sub.mxpkn8ns.ru/api/sub/4wXbnJkbCGcZDKPP';
const EXPIRE = new Date('2026-08-21T00:00:00.000Z');

describe('buildVpnMessageHtml', () => {
  it('ссылка — в <code> (копируется тапом), срок — по-русски', () => {
    const html = buildVpnMessageHtml({ kind: 'new', subscriptionUrl: URL, expireAt: EXPIRE });
    expect(html).toContain(`<code>${URL}</code>`);
    expect(html).toContain('августа 2026');
    expect(html).toContain('Happ');
    expect(html).toContain('URL подписки');
  });

  it('варианты вступления различаются: new / existing / refreshed', () => {
    const base = { subscriptionUrl: URL, expireAt: EXPIRE };
    const fresh = buildVpnMessageHtml({ kind: 'new', ...base });
    const existing = buildVpnMessageHtml({ kind: 'existing', ...base });
    const refreshed = buildVpnMessageHtml({ kind: 'refreshed', ...base });
    expect(fresh).toContain('готов');
    expect(existing).toContain('уже есть');
    expect(refreshed).toContain('новую ссылку');
    expect(new Set([fresh, existing, refreshed]).size).toBe(3);
  });

  it('HTML-небезопасные символы во внешней ссылке экранируются', () => {
    const html = buildVpnMessageHtml({
      kind: 'new',
      subscriptionUrl: 'https://sub.test/api/sub/a?b=1&c=<x>',
      expireAt: EXPIRE,
    });
    expect(html).toContain('a?b=1&amp;c=&lt;x&gt;');
    expect(html).not.toContain('<x>');
  });
});
