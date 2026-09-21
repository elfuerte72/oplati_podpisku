import { beforeEach, describe, expect, it, vi } from 'vitest';

type MarkResult =
  | { status: 'marked'; state: { mode: string } }
  | { status: 'not_awaiting'; state: { mode: string } }
  | { status: 'not_found' };

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
  mark: vi.fn<(...args: unknown[]) => Promise<MarkResult>>(),
  sendMessage: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  invalidate: vi.fn(),
}));

vi.mock('@/lib/panel/session', () => ({ readPanelActor: h.readPanelActor }));
vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    { get: (_t, prop: string) => (prop === 'PANEL_HOST' ? 'admin.oplatishka.com' : undefined) },
  ),
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'admin.oplatishka.com' }),
}));
vi.mock('@oplati/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oplati/db')>();
  return {
    ...actual,
    getDb: () => ({}) as unknown,
    markSupportRequestAnswered: h.mark,
  };
});
vi.mock('@/lib/telegram/bot', () => ({ getBot: () => ({ api: { sendMessage: h.sendMessage } }) }));
vi.mock('@/lib/panel/menu-counts', () => ({ invalidateMenuCounts: h.invalidate }));

import { POST } from './route.ts';

const CONVERSATION_ID = '00000000-0000-4000-8000-00000000c0de';
const STAFF_ID = '00000000-0000-4000-8000-0000000000ff';

function actor(role: 'admin' | 'operator' | 'supervisor') {
  return { id: STAFF_ID, email: 'op@example.com', displayName: 'Менеджер', role, telegramId: '1', lastLoginAt: null };
}
function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://admin.oplatishka.com/api/panel/support/mark-answered', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://admin.oplatishka.com', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.readPanelActor.mockReset();
  h.mark.mockReset();
  h.sendMessage.mockClear();
  h.invalidate.mockClear();
  h.readPanelActor.mockImplementation(async () => actor('operator'));
  h.mark.mockImplementation(async () => ({ status: 'marked', state: { mode: 'idle' } }));
});

/**
 * Ручная отметка «отвечено»: клиенту ответили мимо панели. Снимает обращение
 * со счётчика и у сторожа крона, клиенту не шлёт ничего.
 */
describe('POST /api/panel/support/mark-answered', () => {
  it('отмечает: имя сотрудника уходит в служебную строку, счётчик меню сбрасывается', async () => {
    const res = await POST(request({ conversationId: CONVERSATION_ID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.mark).toHaveBeenCalledWith(expect.anything(), {
      conversationId: CONVERSATION_ID,
      actorName: 'Менеджер',
    });
    expect(h.invalidate).toHaveBeenCalledWith('support');
  });

  it('клиенту НЕ уходит ничего — этим отметка и отличается от «Закрыть»', async () => {
    await POST(request({ conversationId: CONVERSATION_ID }));

    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('снимать нечего (коллега успел, вторая вкладка) — 409, а не тихий успех', async () => {
    h.mark.mockImplementation(async () => ({ status: 'not_awaiting', state: { mode: 'idle' } }));

    const res = await POST(request({ conversationId: CONVERSATION_ID }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'not_awaiting' });
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('разговора нет — 404', async () => {
    h.mark.mockImplementation(async () => ({ status: 'not_found' }));

    expect((await POST(request({ conversationId: CONVERSATION_ID }))).status).toBe(404);
  });

  it('битое тело — 400, до базы не доходит', async () => {
    expect((await POST(request({ conversationId: 'не-uuid' }))).status).toBe(400);
    expect(h.mark).not.toHaveBeenCalled();
  });

  it('чужой Origin — 403: sameSite=lax между www и admin не защищает', async () => {
    const res = await POST(
      request({ conversationId: CONVERSATION_ID }, { origin: 'https://www.oplatishka.com' }),
    );

    expect(res.status).toBe(403);
    expect(h.mark).not.toHaveBeenCalled();
  });

  it('роль без прав — 403; не вошедший — 401', async () => {
    h.readPanelActor.mockImplementation(async () => actor('supervisor'));
    expect((await POST(request({ conversationId: CONVERSATION_ID }))).status).toBe(403);

    h.readPanelActor.mockImplementation(async () => null);
    expect((await POST(request({ conversationId: CONVERSATION_ID }))).status).toBe(401);
    expect(h.mark).not.toHaveBeenCalled();
  });
});
