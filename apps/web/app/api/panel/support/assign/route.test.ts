import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «Подключиться к диалогу» (тикет 10).
 *
 * Что здесь держится: гейты панели, атомарность захвата (чужой диалог не
 * перебивается) и различие «занято коллегой» от «диалога нет» — одинаковый
 * ответ отправлял бы менеджера искать несуществующего человека.
 */

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
  claim: vi.fn(async (..._args: unknown[]): Promise<'claimed' | 'taken' | 'not_found'> => 'claimed'),
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
  return { ...actual, getDb: () => ({}) as unknown, claimSupportConversation: h.claim };
});

import { POST } from './route.ts';

const CONVERSATION_ID = '00000000-0000-4000-8000-00000000c0de';
const STAFF_ID = '00000000-0000-4000-8000-0000000000ff';

function actor(role: 'admin' | 'operator' | 'supervisor') {
  return {
    id: STAFF_ID,
    email: 'op@example.com',
    displayName: 'Менеджер',
    role,
    telegramId: '1',
    lastLoginAt: null,
  };
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://admin.oplatishka.com/api/panel/support/assign', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://admin.oplatishka.com',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.readPanelActor.mockReset();
  h.claim.mockReset();
  h.readPanelActor.mockImplementation(async () => actor('operator'));
  h.claim.mockImplementation(async () => 'claimed');
});

describe('POST /api/panel/support/assign', () => {
  it('менеджер подключается к свободному диалогу', async () => {
    const res = await POST(request({ conversationId: CONVERSATION_ID }));

    expect(res.status).toBe(200);
    expect(h.claim).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: CONVERSATION_ID, staffId: STAFF_ID }),
    );
  });

  it('не вошедший получает 401 и диалог не трогает', async () => {
    h.readPanelActor.mockImplementation(async () => null);

    const res = await POST(request({ conversationId: CONVERSATION_ID }));

    expect(res.status).toBe(401);
    expect(h.claim).not.toHaveBeenCalled();
  });

  it('роль без прав не подключается даже прямым запросом', async () => {
    h.readPanelActor.mockImplementation(async () => actor('supervisor'));

    const res = await POST(request({ conversationId: CONVERSATION_ID }));

    expect(res.status).toBe(403);
    expect(h.claim).not.toHaveBeenCalled();
  });

  it('чужой Origin не проходит', async () => {
    const res = await POST(
      request({ conversationId: CONVERSATION_ID }, { origin: 'https://www.oplatishka.com' }),
    );

    expect(res.status).toBe(403);
    expect(h.claim).not.toHaveBeenCalled();
  });

  it('занятый коллегой диалог — 409, а не молчание', async () => {
    h.claim.mockImplementation(async () => 'taken');

    const res = await POST(request({ conversationId: CONVERSATION_ID }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'assigned_to_other' });
  });

  it('несуществующий диалог — 404, а не «ведёт другой сотрудник»', async () => {
    h.claim.mockImplementation(async () => 'not_found');

    const res = await POST(request({ conversationId: CONVERSATION_ID }));

    expect(res.status).toBe(404);
  });

  it('битое тело отвергается до похода в базу', async () => {
    const res = await POST(request({ conversationId: 'не-uuid' }));

    expect(res.status).toBe(400);
    expect(h.claim).not.toHaveBeenCalled();
  });
});
