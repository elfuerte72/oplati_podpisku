import { describe, expect, it } from 'vitest';

import { buildVpnMessageHtml } from './templates';

const URL = 'https://sub.mxpkn8ns.ru/api/sub/4wXbnJkbCGcZDKPP';
const EXPIRE = new Date('2026-08-21T00:00:00.000Z');
const BASE = { subscriptionUrl: URL, expireAt: EXPIRE, trafficLimitGb: 200 };

describe('buildVpnMessageHtml', () => {
  it('ссылка — в <code> (копируется тапом), срок по-русски, флаги стран', () => {
    const html = buildVpnMessageHtml({ kind: 'new', ...BASE });
    expect(html).toContain(`<code>${URL}</code>`);
    // Без хвоста « г.» из ru-RU-формата — иначе в предложении двойная точка.
    expect(html).toContain('до 21 августа 2026. ');
    expect(html).not.toContain('..');
    expect(html).toContain('Happ');
    expect(html).toContain('URL подписки');
    expect(html).toContain('🇱🇹 Литва');
    expect(html).toContain('🇷🇺 «При белых списках»');
  });

  it('лимит трафика из env попадает в текст; 0 = безлимит', () => {
    expect(buildVpnMessageHtml({ kind: 'new', ...BASE })).toContain('200 ГБ в месяц');
    expect(
      buildVpnMessageHtml({ kind: 'new', ...BASE, trafficLimitGb: 0 }),
    ).toContain('безлимит');
  });

  it('варианты вступления различаются: new / existing / refreshed', () => {
    const fresh = buildVpnMessageHtml({ kind: 'new', ...BASE });
    const existing = buildVpnMessageHtml({ kind: 'existing', ...BASE });
    const refreshed = buildVpnMessageHtml({ kind: 'refreshed', ...BASE });
    expect(fresh).toContain('готов');
    expect(existing).toContain('уже выпущена');
    expect(refreshed).toContain('Ссылка обновлена');
    expect(new Set([fresh, existing, refreshed]).size).toBe(3);
  });

  it('HTML-небезопасные символы во внешней ссылке экранируются', () => {
    const html = buildVpnMessageHtml({
      kind: 'new',
      ...BASE,
      subscriptionUrl: 'https://sub.test/api/sub/a?b=1&c=<x>',
    });
    expect(html).toContain('a?b=1&amp;c=&lt;x&gt;');
    expect(html).not.toContain('<x>');
  });
});
