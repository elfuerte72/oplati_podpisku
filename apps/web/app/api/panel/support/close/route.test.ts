import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
  getThread: vi.fn(),
  transition: vi.fn<(...args: unknown[]) => Promise<{ transitioned: boolean; state: null }>>(
    async () => ({ transitioned: true, state: null }),
  ),
  sendMessage: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  track: vi.fn(),
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
    getSupportThreadForPanel: h.getThread,
    transitionConversationMode: h.transition,
  };
});
vi.mock('@/lib/telegram/bot', () => ({ getBot: () => ({ api: { sendMessage: h.sendMessage } }) }));
vi.mock('@/lib/analytics/track', () => ({ trackServer: h.track }));
vi.mock('@/lib/panel/menu-counts', () => ({ invalidateMenuCounts: vi.fn() }));

import { POST } from './route.ts';

const CONVERSATION_ID = '00000000-0000-4000-8000-00000000c0de';
const STAFF_ID = '00000000-0000-4000-8000-0000000000ff';
const OTHER_STAFF = '00000000-0000-4000-8000-0000000000ee';

function actor(role: 'admin' | 'operator' | 'supervisor') {
  return { id: STAFF_ID, email: 'op@example.com', displayName: 'Менеджер', role, telegramId: '1', lastLoginAt: null };
}
function thread(over: Record<string, unknown> = {}) {
  return {
    conversationId: CONVERSATION_ID,
    client: { id: 'user-1', displayName: 'Клиент', telegramId: '555' },
    assignedOperatorId: STAFF_ID,
    assignedOperatorName: 'Менеджер',
    handoffMode: 'operator',
    messages: [],
    hasMore: false,
    ...over,
  };
}
function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://admin.oplatishka.com/api/panel/support/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://admin.oplatishka.com', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.readPanelActor.mockReset();
  h.getThread.mockReset();
  h.transition.mockReset();
  h.sendMessage.mockReset();
  h.track.mockClear();
  h.readPanelActor.mockImplementation(async () => actor('operator'));
  h.getThread.mockImplementation(async () => thread());
  h.transition.mockImplementation(async () => ({ transitioned: true, state: null }));
  h.sendMessage.mockImplementation(async () => {});
});

/**
 * «Закрыть» (тикет 07): `operator → idle` из любого режима оператора, клиенту
 * «оператор завершил обращение». Чужой закрыть можно — это способ завершить.
 */
describe('POST /api/panel/support/close', () => {
  it('закрывает: переход в idle, ведущий и срок сняты, клиент уведомлён', async () => {
    const res = await POST(request({ conversationId: CONVERSATION_ID }));

    expect(res.status).toBe(200);
    expect(h.transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        from: 'operator',
        to: 'idle',
        trigger: 'operator_close',
        modeExpiresAt: null,
        assignedOperatorId: null,
      }),
    );
    expect(h.sendMessage).toHaveBeenCalledWith('555', expect.stringContaining('завершил обращение'));
    expect(h.track).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'support_session_closed', props: { stage: 'operator' } }),
    );
  });

  it('чужой разговор закрыть МОЖНО — это способ его завершить, а не перехватить', async () => {
    h.getThread.mockImplementation(async () => thread({ assignedOperatorId: OTHER_STAFF }));

    expect((await POST(request({ conversationId: CONVERSATION_ID }))).status).toBe(200);
  });

  it('кто закрыл — в причине перехода, чтобы лента панели это показала', async () => {
    await POST(request({ conversationId: CONVERSATION_ID }));

    expect(h.transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'Менеджер' }),
    );
  });

  it('разговор уже не у оператора — 409, без уведомления', async () => {
    h.transition.mockImplementation(async () => ({ transitioned: false, state: null }));

    const res = await POST(request({ conversationId: CONVERSATION_ID }));

    expect(res.status).toBe(409);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('клиент без Telegram — закрываем молча', async () => {
    h.getThread.mockImplementation(async () => thread({ client: { id: 'u', displayName: null, telegramId: null } }));

    expect((await POST(request({ conversationId: CONVERSATION_ID }))).status).toBe(200);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('роль без прав — 403; не вошедший — 401', async () => {
    h.readPanelActor.mockImplementation(async () => actor('supervisor'));
    expect((await POST(request({ conversationId: CONVERSATION_ID }))).status).toBe(403);

    h.readPanelActor.mockImplementation(async () => null);
    expect((await POST(request({ conversationId: CONVERSATION_ID }))).status).toBe(401);
  });
});
