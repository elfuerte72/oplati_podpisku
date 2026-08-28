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
 * «Вернуть помощнику» (тикет 07): `operator → ai`, только ведущему или админу,
 * клиенту — «оператор передал диалог помощнику».
 */
describe('POST /api/panel/support/return', () => {
  it('ведущий возвращает разговор помощнику: переход, ведущий снят, клиент уведомлён', async () => {
    const res = await POST(request({ conversationId: CONVERSATION_ID }));

    expect(res.status).toBe(200);
    expect(h.transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: 'operator', to: 'ai', trigger: 'operator_return', assignedOperatorId: null }),
    );
    expect(h.sendMessage).toHaveBeenCalledWith('555', expect.stringContaining('передал диалог помощнику'));
    expect(h.track).toHaveBeenCalledWith(expect.objectContaining({ name: 'support_returned_to_ai' }));
  });

  it('срок сессии помощника после возврата — 30 минут', async () => {
    const before = Date.now();
    await POST(request({ conversationId: CONVERSATION_ID }));

    const call = h.transition.mock.calls[0]?.[1] as { modeExpiresAt: Date } | undefined;
    const ms = (call?.modeExpiresAt.getTime() ?? 0) - before;
    expect(ms).toBeGreaterThan(29 * 60_000);
    expect(ms).toBeLessThan(31 * 60_000);
  });

  it('чужой разговор менеджер вернуть не может — 409', async () => {
    h.getThread.mockImplementation(async () => thread({ assignedOperatorId: OTHER_STAFF }));

    const res = await POST(request({ conversationId: CONVERSATION_ID }));

    expect(res.status).toBe(409);
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('владение — в предикате перехода (TOCTOU): менеджер — только свой/свободный, админ — любой', async () => {
    // Между `canReturnToAi` и UPDATE разговор мог захватить коллега: проверка
    // до перехода это не ловит, предикат в самом UPDATE — ловит.
    await POST(request({ conversationId: CONVERSATION_ID }));
    expect(h.transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ onlyIfFreeOrOwnedBy: STAFF_ID }),
    );

    h.transition.mockClear();
    h.readPanelActor.mockImplementation(async () => actor('admin'));
    await POST(request({ conversationId: CONVERSATION_ID }));
    const call = h.transition.mock.calls[0]?.[1] as { onlyIfFreeOrOwnedBy?: string } | undefined;
    expect(call?.onlyIfFreeOrOwnedBy).toBeUndefined();
  });

  it('админ возвращает любой — сотрудник в отпуске, разговор висит', async () => {
    h.readPanelActor.mockImplementation(async () => actor('admin'));
    h.getThread.mockImplementation(async () => thread({ assignedOperatorId: OTHER_STAFF }));

    expect((await POST(request({ conversationId: CONVERSATION_ID }))).status).toBe(200);
  });

  it('разговор уже не у оператора (устаревшая страница) — 409, без уведомления', async () => {
    h.transition.mockImplementation(async () => ({ transitioned: false, state: null }));

    const res = await POST(request({ conversationId: CONVERSATION_ID }));

    expect(res.status).toBe(409);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('сбой доставки клиенту не откатывает переход', async () => {
    h.sendMessage.mockImplementation(async () => {
      throw new Error('403 blocked');
    });

    expect((await POST(request({ conversationId: CONVERSATION_ID }))).status).toBe(200);
  });

  it('роль без прав — 403; чужой Origin — 403; не вошедший — 401', async () => {
    h.readPanelActor.mockImplementation(async () => actor('supervisor'));
    expect((await POST(request({ conversationId: CONVERSATION_ID }))).status).toBe(403);

    h.readPanelActor.mockImplementation(async () => actor('operator'));
    expect(
      (await POST(request({ conversationId: CONVERSATION_ID }, { origin: 'https://www.oplatishka.com' }))).status,
    ).toBe(403);

    h.readPanelActor.mockImplementation(async () => null);
    expect((await POST(request({ conversationId: CONVERSATION_ID }))).status).toBe(401);
  });
});
