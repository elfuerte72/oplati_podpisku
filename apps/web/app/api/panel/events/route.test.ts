import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PanelLiveEvent, PanelLiveListener } from '@/lib/panel/live-events';

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
  listeners: new Set<PanelLiveListener>(),
  unsubscribe: vi.fn(),
}));

vi.mock('@/lib/panel/session', () => ({ readPanelActor: h.readPanelActor }));
vi.mock('@/lib/panel/live-events', () => ({
  subscribePanelLive: (listener: PanelLiveListener) => {
    h.listeners.add(listener);
    return () => {
      h.listeners.delete(listener);
      h.unsubscribe();
    };
  },
}));
// Оператору закрыт раздел `feedback` — в проде обеим ролям открыто всё живое,
// поэтому фильтр по правам проверяется на подмене, а не на живой таблице.
vi.mock('@/lib/panel/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/panel/permissions')>();
  return {
    ...actual,
    canAccess: (role: string, capability: string) =>
      role === 'operator' && capability === 'feedback' ? false : actual.canAccess(role as 'admin', capability as 'desk'),
  };
});

import { GET, PANEL_EVENTS_HEARTBEAT_MS, PANEL_EVENTS_MAX_STREAMS } from './route.ts';

const STAFF_ID = '00000000-0000-4000-8000-0000000000ff';

function actor(role: 'admin' | 'operator') {
  return { id: STAFF_ID, email: 'op@example.com', displayName: 'Менеджер', role, telegramId: '1', lastLoginAt: null };
}

function request(signal?: AbortSignal): Request {
  return new Request('https://admin.oplatishka.com/api/panel/events', { method: 'GET', signal });
}

function emit(event: PanelLiveEvent): void {
  for (const listener of h.listeners) listener(event);
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  if (done) return '';
  return new TextDecoder().decode(value);
}

describe('GET /api/panel/events — живые события панели (SSE)', () => {
  beforeEach(() => {
    h.readPanelActor.mockReset();
    h.listeners.clear();
    h.unsubscribe.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('без сессии — 401, поток не открывается', async () => {
    h.readPanelActor.mockResolvedValue(null);
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(h.listeners.size).toBe(0);
  });

  it('открывает поток event-stream без кэша и сразу задаёт retry', async () => {
    h.readPanelActor.mockResolvedValue(actor('admin'));
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('cache-control')).toContain('no-transform');
    const reader = res.body!.getReader();
    const first = await readChunk(reader);
    expect(first).toContain('retry: ');
    expect(h.listeners.size).toBe(1);
    await reader.cancel();
  });

  it('событие хаба уходит клиенту как event: change с разделами', async () => {
    h.readPanelActor.mockResolvedValue(actor('admin'));
    const res = await GET(request());
    const reader = res.body!.getReader();
    await readChunk(reader);
    emit({ sections: ['orders', 'pending'] });
    const chunk = await readChunk(reader);
    expect(chunk).toBe('event: change\ndata: {"sections":["orders","pending"]}\n\n');
    await reader.cancel();
  });

  it('разделы, закрытые роли, из события вырезаются; пустое событие не уходит', async () => {
    h.readPanelActor.mockResolvedValue(actor('operator'));
    const res = await GET(request());
    const reader = res.body!.getReader();
    await readChunk(reader);
    emit({ sections: ['feedback'] });
    emit({ sections: ['feedback', 'support'] });
    const chunk = await readChunk(reader);
    expect(chunk).toBe('event: change\ndata: {"sections":["support"]}\n\n');
    await reader.cancel();
  });

  it('пинг держит соединение живым через прокси', async () => {
    vi.useFakeTimers();
    h.readPanelActor.mockResolvedValue(actor('admin'));
    const res = await GET(request());
    const reader = res.body!.getReader();
    await readChunk(reader);
    vi.advanceTimersByTime(PANEL_EVENTS_HEARTBEAT_MS);
    const chunk = await readChunk(reader);
    expect(chunk).toBe(': ping\n\n');
    await reader.cancel();
  });

  it('потолок открытых потоков: сверх него — 503, а не бесконечный рост подписок', async () => {
    h.readPanelActor.mockResolvedValue(actor('admin'));
    const controllers: AbortController[] = [];
    try {
      for (let i = 0; i < PANEL_EVENTS_MAX_STREAMS; i++) {
        const controller = new AbortController();
        controllers.push(controller);
        const res = await GET(request(controller.signal));
        expect(res.status).toBe(200);
        await readChunk(res.body!.getReader());
      }
      const overflow = await GET(request());
      expect(overflow.status).toBe(503);
      expect(h.listeners.size).toBe(PANEL_EVENTS_MAX_STREAMS);
    } finally {
      for (const controller of controllers) controller.abort();
    }
    // Освобождённые слоты снова доступны.
    const again = await GET(request());
    expect(again.status).toBe(200);
    await again.body!.getReader().cancel();
  });

  it('обрыв соединения снимает подписку и закрывает поток', async () => {
    h.readPanelActor.mockResolvedValue(actor('admin'));
    const controller = new AbortController();
    const res = await GET(request(controller.signal));
    const reader = res.body!.getReader();
    await readChunk(reader);
    controller.abort();
    const { done } = await reader.read();
    expect(done).toBe(true);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.listeners.size).toBe(0);
  });
});
