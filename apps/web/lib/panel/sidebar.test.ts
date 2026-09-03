import { describe, expect, it } from 'vitest';

import {
  SIDEBAR_COLLAPSED_VALUE,
  SIDEBAR_COOKIE,
  isSidebarCollapsed,
  sidebarCookieString,
} from './sidebar';

/**
 * Состояние бокового меню. Проверяется именно чтение и запись cookie: оболочку
 * рендерит каждая страница заново, и ошибка здесь означает не «некрасиво», а
 * «меню разворачивается на каждом клике».
 */
describe('isSidebarCollapsed', () => {
  it('свёрнуто только по своему значению', () => {
    expect(isSidebarCollapsed(SIDEBAR_COLLAPSED_VALUE)).toBe(true);
  });

  it('нет cookie — меню развёрнуто', () => {
    expect(isSidebarCollapsed(undefined)).toBe(false);
    expect(isSidebarCollapsed('')).toBe(false);
  });

  it('незнакомое значение читается как развёрнутое', () => {
    // Развёрнутое меню читается без обучения, свёрнутое — набор букв. При
    // сомнении показываем то, что понятно.
    expect(isSidebarCollapsed('1')).toBe(false);
    expect(isSidebarCollapsed('true')).toBe(false);
    expect(isSidebarCollapsed('COLLAPSED')).toBe(false);
  });
});

describe('sidebarCookieString', () => {
  it('свернуть — записать значение на год', () => {
    const cookie = sidebarCookieString(true);
    expect(cookie).toContain(`${SIDEBAR_COOKIE}=${SIDEBAR_COLLAPSED_VALUE}`);
    expect(cookie).toContain('Max-Age=31536000');
  });

  it('развернуть — погасить cookie, а не записать второе значение', () => {
    // `Max-Age=0` убирает cookie. Запись «expanded» оставила бы в браузере
    // строку, которую потом пришлось бы понимать отдельно от её отсутствия.
    const cookie = sidebarCookieString(false);
    expect(cookie).toContain(`${SIDEBAR_COOKIE}=;`);
    expect(cookie).toContain('Max-Age=0');
  });

  it('путь и SameSite заданы всегда', () => {
    // Cookie с другим `Path` не перезаписывает прежнюю, а ложится второй — и
    // меню начинает зависеть от того, с какого экрана его свернули.
    for (const collapsed of [true, false]) {
      const cookie = sidebarCookieString(collapsed);
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('SameSite=Lax');
    }
  });
});
