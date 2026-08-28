import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ответ клиенту из панели (тикет 10).
 *
 * Что здесь держится:
 *   - ответ уходит через СУЩЕСТВУЮЩЕГО клиентского бота, от имени бота;
 *   - текст оператора маскируется от номеров карт — как клиентский;
 *   - запись в переписку идёт ПОСЛЕ отправки, и её потеря видна;
 *   - клиенту без Telegram и в чужом диалоге операция отказывает.
 */

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
  getThread: vi.fn(),
  appendMessage: vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({ id: 'm1' })),
  sendMessage: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  captureException: vi.fn(),
  // Захват разговора (тикет 07): по умолчанию удаётся. `transitioned: false`
  // моделирует «чужой разговор» — условие «свободен или мой» не совпало.
  transition: vi.fn<(...args: unknown[]) => Promise<{ transitioned: boolean; state: null }>>(
    async () => ({ transitioned: true, state: null }),
  ),
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
    appendMessage: h.appendMessage,
    transitionConversationMode: h.transition,
  };
});

vi.mock('@/lib/analytics/track', () => ({ trackServer: h.track }));

vi.mock('@/lib/telegram/bot', () => ({
  getBot: () => ({ api: { sendMessage: h.sendMessage } }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: h.captureException,
  captureMessage: vi.fn(),
}));

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

function thread(over: Record<string, unknown> = {}) {
  return {
    conversationId: CONVERSATION_ID,
    client: { id: 'user-1', displayName: 'Клиент', telegramId: '555' },
    assignedOperatorId: null,
    assignedOperatorName: null,
    handoffMode: 'ai',
    messages: [],
    hasMore: false,
    ...over,
  };
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://admin.oplatishka.com/api/panel/support/reply', {
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
  h.getThread.mockReset();
  h.appendMessage.mockReset();
  h.sendMessage.mockReset();
  h.captureException.mockClear();
  h.transition.mockReset();
  h.transition.mockImplementation(async () => ({ transitioned: true, state: null }));
  h.track.mockClear();
  h.readPanelActor.mockImplementation(async () => actor('operator'));
  h.getThread.mockImplementation(async () => thread());
  h.appendMessage.mockImplementation(async () => ({ id: 'm1' }));
  h.sendMessage.mockImplementation(async () => {});
});

describe('POST /api/panel/support/reply — доступ', () => {
  it('менеджер отвечает клиенту', async () => {
    const res = await POST(request({ conversationId: CONVERSATION_ID, text: 'Разобрались!' }));

    expect(res.status).toBe(200);
    // Клиент видит префикс «Оператор: » (спека §7 п. 3) — он обязан отличать
    // человека от помощника.
    expect(h.sendMessage).toHaveBeenCalledWith('555', 'Оператор: Разобрались!');
  });

  it('не вошедший получает 401', async () => {
    h.readPanelActor.mockImplementation(async () => null);

    const res = await POST(request({ conversationId: CONVERSATION_ID, text: 'Ответ' }));

    expect(res.status).toBe(401);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('роль без прав не отвечает даже прямым запросом', async () => {
    h.readPanelActor.mockImplementation(async () => actor('supervisor'));

    const res = await POST(request({ conversationId: CONVERSATION_ID, text: 'Ответ' }));

    expect(res.status).toBe(403);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('чужой Origin не проходит', async () => {
    const res = await POST(
      request(
        { conversationId: CONVERSATION_ID, text: 'Ответ' },
        { origin: 'https://www.oplatishka.com' },
      ),
    );

    expect(res.status).toBe(403);
  });
});

describe('POST /api/panel/support/reply — правила', () => {
  it('ответ пишется строкой оператора со ссылкой на сотрудника', async () => {
    await POST(request({ conversationId: CONVERSATION_ID, text: 'Готово' }));

    expect(h.appendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        role: 'operator',
        staffId: STAFF_ID,
        content: 'Готово',
      }),
    );
  });

  it('номер карты в ответе маскируется — и в Telegram, и в базе', async () => {
    // Оператор цитирует номер из обращения клиента. Политика «полный PAN не
    // оседает в базе» от направления сообщения не зависит; клиент при этом
    // обязан увидеть ровно то, что записано в переписке.
    await POST(
      request({ conversationId: CONVERSATION_ID, text: 'Карта 5395 0203 8822 0113 закрыта' }),
    );

    const sent = String(h.sendMessage.mock.calls[0]?.[1]);
    const stored = (h.appendMessage.mock.calls[0]?.[1] as { content: string }).content;
    expect(sent).not.toContain('5395020388220113');
    expect(sent).not.toContain('5395 0203 8822 0113');
    // Клиенту — с префиксом «Оператор: » (спека §7 п. 3), в базе — без него:
    // маскирование одинаковое, отличие только в свойстве доставки.
    expect(sent).toBe(`Оператор: ${stored}`);
  });

  it('запись идёт ПОСЛЕ отправки', async () => {
    await POST(request({ conversationId: CONVERSATION_ID, text: 'Ответ' }));

    const sendOrder = h.sendMessage.mock.invocationCallOrder[0] ?? 0;
    const recordOrder = h.appendMessage.mock.invocationCallOrder[0] ?? 0;
    expect(sendOrder).toBeLessThan(recordOrder);
  });

  it('сорванная отправка не пишется в переписку', async () => {
    // Иначе следующий менеджер увидит ответ, которого клиент не получал, и
    // не станет отвечать.
    h.sendMessage.mockImplementation(async () => {
      throw new Error('Forbidden: bot was blocked by the user');
    });

    const res = await POST(request({ conversationId: CONVERSATION_ID, text: 'Ответ' }));

    expect(res.status).toBe(502);
    expect(h.appendMessage).not.toHaveBeenCalled();
  });

  it('потеря записи после доставки видна и в ответе, и в Sentry', async () => {
    h.appendMessage.mockImplementation(async () => {
      throw new Error('connection terminated');
    });

    const res = await POST(request({ conversationId: CONVERSATION_ID, text: 'Ответ' }));

    expect(await res.json()).toMatchObject({ ok: true, warning: 'not_recorded' });
    expect(h.captureException).toHaveBeenCalled();
  });

  it('клиенту без Telegram не отвечаем', async () => {
    h.getThread.mockImplementation(async () =>
      thread({ client: { id: 'user-1', displayName: 'Веб', telegramId: null } }),
    );

    const res = await POST(request({ conversationId: CONVERSATION_ID, text: 'Ответ' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_telegram' });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('в чужой диалог не вмешиваемся', async () => {
    h.getThread.mockImplementation(async () => thread({ assignedOperatorId: 'staff-2' }));

    const res = await POST(request({ conversationId: CONVERSATION_ID, text: 'Ответ' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'assigned_to_other' });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('свой диалог отвечать не мешает', async () => {
    h.getThread.mockImplementation(async () => thread({ assignedOperatorId: STAFF_ID }));

    const res = await POST(request({ conversationId: CONVERSATION_ID, text: 'Ответ' }));

    expect(res.status).toBe(200);
  });

  it('пустой ответ отвергается до похода в базу', async () => {
    const res = await POST(request({ conversationId: CONVERSATION_ID, text: ' ' }));

    expect(res.status).toBe(400);
    expect(h.getThread).not.toHaveBeenCalled();
  });

  it('не-JSON тело отвергается до похода в базу', async () => {
    const res = await POST(
      new Request('https://admin.oplatishka.com/api/panel/support/reply', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://admin.oplatishka.com',
        },
        body: 'не json',
      }),
    );

    expect(res.status).toBe(400);
    expect(h.getThread).not.toHaveBeenCalled();
  });

  it('слишком длинный ответ Telegram не отправляем', async () => {
    // Лимит сообщения у Telegram конечен: отправка простыни вернула бы ошибку
    // провайдера там, где достаточно сказать это менеджеру сразу.
    const res = await POST(
      request({ conversationId: CONVERSATION_ID, text: 'а'.repeat(5000) }),
    );

    expect(res.status).toBe(400);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('несуществующий диалог — 404', async () => {
    h.getThread.mockImplementation(async () => null);

    const res = await POST(request({ conversationId: CONVERSATION_ID, text: 'Ответ' }));

    expect(res.status).toBe(404);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});

describe('POST /api/panel/support/reply — ответ = захват (тикет 07)', () => {
  it('ответ атомарно переводит разговор в режим оператора и закрепляет за собой', async () => {
    await POST(request({ conversationId: CONVERSATION_ID, text: 'Готово' }));

    expect(h.transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        to: 'operator',
        trigger: 'operator_reply',
        assignedOperatorId: STAFF_ID,
        onlyIfFreeOrOwnedBy: STAFF_ID,
      }),
    );
  });

  it('срок режима после ответа — 24 часа', async () => {
    const before = Date.now();
    await POST(request({ conversationId: CONVERSATION_ID, text: 'Готово' }));

    const call = h.transition.mock.calls[0]?.[1] as { modeExpiresAt: Date } | undefined;
    const ms = (call?.modeExpiresAt.getTime() ?? 0) - before;
    expect(ms).toBeGreaterThan(23.9 * 3_600_000);
    expect(ms).toBeLessThan(24.1 * 3_600_000);
  });

  it('РЕГРЕСС V11: повторный ответ в своём разговоре — touch, событие эскалации НЕ пишется', async () => {
    h.transition.mockImplementation(async () => ({ transitioned: true, touched: true, state: null }));
    await POST(request({ conversationId: CONVERSATION_ID, text: 'Ещё раз' }));

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.track).not.toHaveBeenCalled();
  });

  it('первый ответ — настоящий переход: событие эскалации пишется один раз', async () => {
    await POST(request({ conversationId: CONVERSATION_ID, text: 'Готово' }));
    expect(h.track).toHaveBeenCalledTimes(1);
  });

  it('захват не удался (чужой разговор) — 409, клиенту ничего не уходит', async () => {
    h.transition.mockImplementation(async () => ({ transitioned: false, state: null }));

    const res = await POST(request({ conversationId: CONVERSATION_ID, text: 'Готово' }));

    expect(res.status).toBe(409);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.appendMessage).not.toHaveBeenCalled();
  });

  it('в БД текст лежит БЕЗ префикса — префикс свойство доставки, не содержания', async () => {
    await POST(request({ conversationId: CONVERSATION_ID, text: 'Готово' }));

    expect(h.appendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: 'Готово', role: 'operator' }),
    );
  });
});
