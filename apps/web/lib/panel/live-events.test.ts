import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  invalidateMenuCounts: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@/lib/panel/menu-counts', () => ({ invalidateMenuCounts: h.invalidateMenuCounts }));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException }));

import { emitDbChange } from '@oplati/db';

import {
  PANEL_LIVE_COALESCE_MS,
  subscribePanelLive,
  type PanelLiveEvent,
} from './live-events';

describe('живые события панели: таблица → разделы, склейка, подписка', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.invalidateMenuCounts.mockClear();
    h.captureException.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('запись в messages доходит подписчику как раздел support', () => {
    const seen: PanelLiveEvent[] = [];
    const off = subscribePanelLive((e) => seen.push(e));
    try {
      emitDbChange('messages');
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(PANEL_LIVE_COALESCE_MS);
      expect(seen).toEqual([{ sections: ['support'] }]);
    } finally {
      off();
    }
  });

  it('несколько записей в окне склейки — одно событие с объединением разделов', () => {
    const seen: PanelLiveEvent[] = [];
    const off = subscribePanelLive((e) => seen.push(e));
    try {
      emitDbChange('orders');
      emitDbChange('payments');
      emitDbChange('orders');
      vi.advanceTimersByTime(PANEL_LIVE_COALESCE_MS);
      expect(seen).toEqual([{ sections: ['holds', 'orders', 'pending'] }]);
    } finally {
      off();
    }
  });

  it('памятка счётчиков меню сбрасывается сразу и только для разделов с бейджем', () => {
    const off = subscribePanelLive(() => {});
    try {
      emitDbChange('orders');
      expect(h.invalidateMenuCounts.mock.calls.map((c) => c[0]).sort()).toEqual(['holds', 'pending']);
      emitDbChange('client_feedback');
      expect(h.invalidateMenuCounts).toHaveBeenCalledWith('feedback');
    } finally {
      off();
    }
  });

  it('после отписки события не приходят, а последний отписавшийся снимает и слушателя базы', () => {
    const seen: PanelLiveEvent[] = [];
    const off = subscribePanelLive((e) => seen.push(e));
    off();
    emitDbChange('messages');
    vi.advanceTimersByTime(PANEL_LIVE_COALESCE_MS);
    expect(seen).toEqual([]);
    // Слушателя базы нет — памятку никто не трогает.
    expect(h.invalidateMenuCounts).not.toHaveBeenCalled();
  });

  it('упавший подписчик не глушит остальных — ошибка уходит в Sentry', () => {
    const seen: PanelLiveEvent[] = [];
    const offBroken = subscribePanelLive(() => {
      throw new Error('вкладка сломана');
    });
    const offOk = subscribePanelLive((e) => seen.push(e));
    try {
      emitDbChange('conversations');
      vi.advanceTimersByTime(PANEL_LIVE_COALESCE_MS);
      expect(seen).toEqual([{ sections: ['support'] }]);
      expect(h.captureException).toHaveBeenCalledTimes(1);
    } finally {
      offBroken();
      offOk();
    }
  });
});
