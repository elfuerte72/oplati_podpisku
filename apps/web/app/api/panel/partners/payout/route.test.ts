import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Решение по заявке на вывод (тикет 12) — реальные деньги партнёра.
 *
 * Что здесь держится:
 *   - раздел ТОЛЬКО владельца: менеджер не проводит выплату даже прямым
 *     запросом;
 *   - «выплачено» идёт ДВУМЯ переходами через существующий атомарный механизм,
 *     а не одним прыжком мимо машины статусов;
 *   - «отклонить» работает с первого дня: без неё первая же заявка замораживает
 *     деньги партнёра навсегда;
 *   - повторное нажатие не проводит выплату дважды.
 */

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
  transition: vi.fn(),
  findPayout: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
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
    transitionReferralPayout: h.transition,
    findReferralPayoutForPanel: h.findPayout,
  };
});

vi.mock('@sentry/nextjs', () => ({
  captureException: h.captureException,
  captureMessage: h.captureMessage,
}));

import { POST } from './route.ts';

const PAYOUT_ID = '00000000-0000-4000-8000-00000000pa11'.replace('pa11', 'ba11');
const STAFF_ID = '00000000-0000-4000-8000-0000000000ff';

function actor(role: 'admin' | 'operator' | 'supervisor') {
  return {
    id: STAFF_ID,
    email: 'own@example.com',
    displayName: 'Владелец',
    role,
    telegramId: '1',
    lastLoginAt: null,
  };
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://admin.oplatishka.com/api/panel/partners/payout', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://admin.oplatishka.com',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const PARTNER_ID = '00000000-0000-4000-8000-0000000000c1';

/** Заявка в базе. По умолчанию — обычная живая заявка незаблокированного партнёра. */
function payoutRow(over: Partial<{ status: string; suspended: boolean }> = {}) {
  return {
    id: PAYOUT_ID,
    userId: PARTNER_ID,
    status: over.status ?? 'requested',
    amountUsdCents: 500,
    suspended: over.suspended ?? false,
  };
}

beforeEach(() => {
  h.readPanelActor.mockReset();
  h.transition.mockReset();
  h.findPayout.mockReset();
  h.findPayout.mockImplementation(async () => payoutRow());
  h.captureException.mockClear();
  h.captureMessage.mockClear();
  h.readPanelActor.mockImplementation(async () => actor('admin'));
  h.transition.mockImplementation(async (_db: unknown, params: { to: string }) => ({
    applied: true,
    status: params.to,
  }));
});

describe('POST /api/panel/partners/payout — доступ', () => {
  it('владелец проводит решение по заявке', async () => {
    const res = await POST(request({ payoutId: PAYOUT_ID, action: 'reject' }));

    expect(res.status).toBe(200);
  });

  it('МЕНЕДЖЕР не проводит выплату даже прямым запросом', async () => {
    // Реферальные деньги — раздел владельца (спека §4.3).
    h.readPanelActor.mockImplementation(async () => actor('operator'));

    const res = await POST(request({ payoutId: PAYOUT_ID, action: 'paid' }));

    expect(res.status).toBe(403);
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('не вошедший получает 401', async () => {
    h.readPanelActor.mockImplementation(async () => null);

    const res = await POST(request({ payoutId: PAYOUT_ID, action: 'paid' }));

    expect(res.status).toBe(401);
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('чужой Origin не проходит', async () => {
    const res = await POST(
      request({ payoutId: PAYOUT_ID, action: 'paid' }, { origin: 'https://www.oplatishka.com' }),
    );

    expect(res.status).toBe(403);
    expect(h.transition).not.toHaveBeenCalled();
  });
});

describe('POST /api/panel/partners/payout — переходы', () => {
  it('«выплачено» идёт ДВУМЯ переходами через машину статусов', async () => {
    // Прямой `requested → paid` машина не разрешает, и обходить её нельзя:
    // `processing` означает «деньги ушли, ждём подтверждения».
    await POST(request({ payoutId: PAYOUT_ID, action: 'paid' }));

    expect(h.transition).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ payoutId: PAYOUT_ID, from: 'requested', to: 'processing' }),
    );
    expect(h.transition).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ from: 'processing', to: 'paid' }),
    );
  });

  it('«отклонить» — один переход, деньги возвращаются в баланс сами', async () => {
    // Формула баланса не вычитает отклонённые заявки, поэтому компенсирующая
    // строка в append-only ledger'е не нужна и была бы вредна.
    await POST(request({ payoutId: PAYOUT_ID, action: 'reject' }));

    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(h.transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: 'requested', to: 'rejected' }),
    );
  });

  it('повторное нажатие выплату дважды не проводит', async () => {
    // Атомарный claim: второй `requested → processing` не применяется, а статус
    // в ответе — ФАКТИЧЕСКИЙ (так его возвращает `transitionReferralPayout`),
    // а не запрошенный: соврать о состоянии денег нельзя.
    h.transition.mockImplementation(async () => ({ applied: false, status: 'rejected' }));

    const res = await POST(request({ payoutId: PAYOUT_ID, action: 'paid' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'wrong_status', status: 'rejected' });
    expect(h.transition).toHaveBeenCalledTimes(1);
  });

  it('ЗАСТРЯВШУЮ в processing заявку панель добивает одним переходом', async () => {
    // Иначе её сумма вычитается из баланса партнёра до ручного SQL на проде.
    h.findPayout.mockImplementation(async () => payoutRow({ status: 'processing' }));

    const res = await POST(request({ payoutId: PAYOUT_ID, action: 'paid' }));

    expect(res.status).toBe(200);
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(h.transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: 'processing', to: 'paid' }),
    );
  });

  it('застрявшую заявку можно и отклонить — из ФАКТИЧЕСКОГО статуса', async () => {
    h.findPayout.mockImplementation(async () => payoutRow({ status: 'processing' }));

    await POST(request({ payoutId: PAYOUT_ID, action: 'reject' }));

    expect(h.transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: 'processing', to: 'rejected' }),
    );
  });

  it('ЗАБЛОКИРОВАННОМУ антифродом партнёру выплату не проводим', async () => {
    // Кабинет не даёт ему подать заявку, но поданная ДО блокировки живёт в
    // `requested` — без гейта блокировка снималась бы одним кликом в панели.
    h.findPayout.mockImplementation(async () => payoutRow({ suspended: true }));

    const res = await POST(request({ payoutId: PAYOUT_ID, action: 'paid' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'partner_suspended' });
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('а вот ОТКЛОНИТЬ заявку заблокированного можно — это способ её закрыть', async () => {
    h.findPayout.mockImplementation(async () => payoutRow({ suspended: true }));

    const res = await POST(request({ payoutId: PAYOUT_ID, action: 'reject' }));

    expect(res.status).toBe(200);
    expect(h.transition).toHaveBeenCalledTimes(1);
  });

  it('по закрытой заявке решение не проводится вовсе', async () => {
    h.findPayout.mockImplementation(async () => payoutRow({ status: 'paid' }));

    const res = await POST(request({ payoutId: PAYOUT_ID, action: 'reject' }));

    expect(res.status).toBe(409);
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('исчезнувшая заявка — 404, а не молчаливый успех', async () => {
    h.findPayout.mockImplementation(async () => null);

    const res = await POST(request({ payoutId: PAYOUT_ID, action: 'paid' }));

    expect(res.status).toBe(404);
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('заявка застряла в processing — это видно и в ответе, и в Sentry', async () => {
    h.transition.mockImplementation(async (_db: unknown, params: { to: string }) => ({
      applied: params.to === 'processing',
      status: 'processing',
    }));

    const res = await POST(request({ payoutId: PAYOUT_ID, action: 'paid' }));

    expect(res.status).toBe(409);
    expect(h.captureMessage).toHaveBeenCalled();
  });

  it('запрещённый переход — это наша ошибка, а не действие человека', async () => {
    h.transition.mockImplementation(async () => {
      throw new Error('переход requested → paid запрещён машиной статусов');
    });

    const res = await POST(request({ payoutId: PAYOUT_ID, action: 'paid' }));

    expect(res.status).toBe(503);
    expect(h.captureException).toHaveBeenCalled();
  });

  it('битое тело отвергается до похода в базу', async () => {
    const res = await POST(request({ payoutId: 'не-uuid', action: 'paid' }));

    expect(res.status).toBe(400);
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('неизвестное действие не проходит', async () => {
    const res = await POST(request({ payoutId: PAYOUT_ID, action: 'delete' }));

    expect(res.status).toBe(400);
    expect(h.transition).not.toHaveBeenCalled();
  });
});
