import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildVpnMessageHtml } from './templates';

const URL = 'https://sub.example.com/api/sub/TESTshortUuid001';
const EXPIRE = new Date('2026-08-21T00:00:00.000Z');
const BASE = { subscriptionUrl: URL, expireAt: EXPIRE, trafficLimitGb: 200 };

/**
 * ⚠️ Время ЗАМОРОЖЕНО. Шаблон сравнивает срок подписки с `Date.now()`, а даты
 * в тесте зашиты: без заморозки «живая» подписка становится истёкшей ровно в
 * тот день, когда её дата уходит в прошлое, и три теста краснеют сами по себе,
 * без единой правки кода. Так и случилось 2026-08-24 — прогон встал на дате
 * 21 августа, зелёной ещё двумя днями раньше.
 */
const FROZEN_NOW = new Date('2026-08-19T00:00:00.000Z');

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

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

  it('бессрочная подписка: про дату не говорим вовсе', () => {
    // «Доступ действует до 31 декабря 2037» читается как баг и только пугает.
    const html = buildVpnMessageHtml({
      kind: 'new',
      ...BASE,
      expireAt: new Date('2037-12-31T23:59:59.000Z'),
    });
    expect(html).not.toContain('действует до');
    expect(html).not.toContain('2037');
    expect(html).toContain('200 ГБ в месяц');
  });

  it('истёкшая подписка помечается честно, а не выдаётся как рабочая', () => {
    // Регресс: раньше мёртвая ссылка отдавалась с датой из прошлого — клиент
    // вставлял её в Happ и получал пустоту, не понимая, что не так.
    const html = buildVpnMessageHtml({
      kind: 'existing',
      ...BASE,
      expireAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    expect(html).toContain('Срок доступа истёк');
    expect(html).toContain('Обновить ссылку');
    expect(html).not.toContain('Доступ действует до');
  });

  it('живой срочный доступ показывает дату как раньше', () => {
    const html = buildVpnMessageHtml({ kind: 'new', ...BASE });
    expect(html).toContain('Доступ действует до 21 августа 2026.');
    expect(html).not.toContain('истёк');
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
