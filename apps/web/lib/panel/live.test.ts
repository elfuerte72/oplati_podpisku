import { describe, expect, it } from 'vitest';

import { PANEL_REFRESH_MS, canRefreshNow } from './live';

describe('canRefreshNow', () => {
  const idle = { visible: true, busy: false, typing: false };

  it('видимая вкладка без операций обновляется', () => {
    expect(canRefreshNow(idle)).toBe(true);
  });

  it('скрытая вкладка не дёргает процесс, который принимает вебхуки', () => {
    expect(canRefreshNow({ ...idle, visible: false })).toBe(false);
  });

  it('во время операции не обновляем — перерисовка сбивает действие', () => {
    expect(canRefreshNow({ ...idle, busy: true })).toBe(false);
  });

  it('во время набора текста не обновляем — иначе съедим введённое', () => {
    expect(canRefreshNow({ ...idle, typing: true })).toBe(false);
  });

  it('интервал — 25 секунд', () => {
    expect(PANEL_REFRESH_MS).toBe(25_000);
  });
});
