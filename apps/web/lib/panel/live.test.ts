import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PANEL_EVENT_REFRESH_DELAY_MS,
  PANEL_REFRESH_MS,
  canRefreshNow,
  createRefreshScheduler,
} from './live';

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

describe('createRefreshScheduler — перерисовка по живому событию', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(canRefresh: () => boolean = () => true) {
    const refresh = vi.fn();
    const scheduler = createRefreshScheduler({ refresh, canRefresh });
    return { refresh, scheduler };
  }

  it('событие перерисовывает страницу с задержкой, а не мгновенно', () => {
    const { refresh, scheduler } = make();
    scheduler.onEvent();
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PANEL_EVENT_REFRESH_DELAY_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('пачка событий подряд — одна перерисовка', () => {
    const { refresh, scheduler } = make();
    for (let i = 0; i < 5; i++) {
      scheduler.onEvent();
      vi.advanceTimersByTime(PANEL_EVENT_REFRESH_DELAY_MS / 2);
    }
    vi.advanceTimersByTime(PANEL_EVENT_REFRESH_DELAY_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('пока нельзя (скрыта, занята, печатают) — откладывает и перерисовывает, когда вкладка вернулась', () => {
    let allowed = false;
    const { refresh, scheduler } = make(() => allowed);
    scheduler.onEvent();
    vi.advanceTimersByTime(PANEL_EVENT_REFRESH_DELAY_MS);
    expect(refresh).not.toHaveBeenCalled();

    allowed = true;
    scheduler.onVisible();
    expect(refresh).toHaveBeenCalledTimes(1);
    // Отложенное сработало один раз — повторный возврат ничего не дёргает.
    scheduler.onVisible();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('dispose отменяет запланированную перерисовку', () => {
    const { refresh, scheduler } = make();
    scheduler.onEvent();
    scheduler.dispose();
    vi.advanceTimersByTime(PANEL_EVENT_REFRESH_DELAY_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
  });
});
