import { describe, expect, it } from 'vitest';

import { PANEL_SECTION_GROUPS } from './permissions';
import {
  DENSITY_COOKIE,
  NAV_CLOSED_COOKIE,
  PREF_COOKIE_MAX_AGE_SECONDS,
  THEME_COOKIE,
  closedGroupsCookieValue,
  pickCookie,
  prefCookieString,
  readClosedGroups,
  readDensity,
  readTheme,
} from './prefs';

/**
 * Настройки вида панели. Все три читаются НА СЕРВЕРЕ из cookie, и цена ошибки
 * здесь — не «некрасиво», а «раздел пропал» или «каждый переход мигает чужой
 * темой», поэтому проверяется именно поведение на мусорных значениях.
 */
describe('readTheme / readDensity', () => {
  it('умолчания — тёмная тема и просторные строки', () => {
    // Тёмная — правило бренда; просторная строка читается без привыкания.
    expect(readTheme(undefined)).toBe('dark');
    expect(readDensity(undefined)).toBe('cosy');
  });

  it('незнакомое значение берёт умолчание, а не ломает экран', () => {
    // Cookie правится руками и переживает версии панели: значение из будущей
    // (или чужой) версии обязано выглядеть как «настройки нет».
    expect(readTheme('sepia')).toBe('dark');
    expect(readDensity('')).toBe('cosy');
    expect(readTheme('light')).toBe('light');
    expect(readDensity('compact')).toBe('compact');
  });
});

describe('readClosedGroups', () => {
  it('хранится СВЁРНУТОЕ, поэтому незнакомая группа приходит раскрытой', () => {
    // Новый раздел не должен прятаться у тех, кто настроил меню под себя:
    // храни мы раскрытые группы, он исчезал бы ровно у них.
    const closed = readClosedGroups('manage');
    expect(closed.has('manage')).toBe(true);
    expect(closed.has('analytics')).toBe(false);
  });

  it('мусор игнорируется поэлементно, а не складывает меню целиком', () => {
    const closed = readClosedGroups('manage, orders ,<script>,,ГРУППА');
    expect([...closed].sort()).toEqual(['manage', 'orders']);
  });

  it('пустая cookie — ничего не свёрнуто', () => {
    expect(readClosedGroups(undefined).size).toBe(0);
    expect(readClosedGroups('').size).toBe(0);
  });

  it('набор и строка cookie ходят туда-обратно', () => {
    const value = closedGroupsCookieValue(['orders', 'manage']);
    expect([...readClosedGroups(value)]).toEqual(['orders', 'manage']);
  });

  it('каждый настоящий ключ группы проходит фильтр', () => {
    // Фильтр описывает алфавит ключей регэкспом, а ключи живут в
    // `PANEL_SECTION_GROUPS` — связи между ними нет ни типом, ни рантаймом.
    // Заведи группу `aiTools` — тумблер свернёт её в браузере, а сервер молча
    // отбросит ключ, и группа разворачивалась бы на каждом переходе.
    const value = closedGroupsCookieValue(PANEL_SECTION_GROUPS);
    expect([...readClosedGroups(value)]).toEqual([...PANEL_SECTION_GROUPS]);
  });
});

describe('prefCookieString', () => {
  it('пишет настройку на год и на весь путь панели', () => {
    const cookie = prefCookieString(THEME_COOKIE, 'light');
    expect(cookie).toContain(`${THEME_COOKIE}=light`);
    expect(cookie).toContain(`Max-Age=${PREF_COOKIE_MAX_AGE_SECONDS}`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('пустое значение ГАСИТ cookie, а не записывает пустоту', () => {
    // Так снимается последняя свёрнутая группа: строка без `Max-Age=0` осталась
    // бы в браузере пустым значением и на год.
    expect(prefCookieString(NAV_CLOSED_COOKIE, '')).toContain('Max-Age=0');
  });
});

describe('pickCookie', () => {
  it('достаёт нужную настройку из общей строки', () => {
    const all = `__Host-panel_session=xxx; ${THEME_COOKIE}=light; ${DENSITY_COOKIE}=compact`;
    expect(pickCookie(all, THEME_COOKIE)).toBe('light');
    expect(pickCookie(all, DENSITY_COOKIE)).toBe('compact');
    expect(pickCookie(all, NAV_CLOSED_COOKIE)).toBeUndefined();
  });

  it('не путает cookie с похожим окончанием имени', () => {
    // `panel_theme` и `x_panel_theme` — разные cookie; совпадение по хвосту
    // отдало бы тумблеру чужое значение.
    expect(pickCookie(`x_${THEME_COOKIE}=dark`, THEME_COOKIE)).toBeUndefined();
  });
});
