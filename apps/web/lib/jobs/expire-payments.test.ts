import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv (logger, templates).
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

type OrderLike = {
  id: string;
  shortId: string;
  userId: string;
  serviceId: string | null;
  customServiceDescription: string | null;
  amountRub: number | null;
  createdAt: Date;
};

const h = vi.hoisted(() => ({
  state: {
    expired: [] as OrderLike[],
    pendingPayment: null as { id: string } | null,
    service: null as { name: string } | null,
    serviceLookupError: null as Error | null,
  },
  transitionMock: vi.fn(async () => ({})),
  claimMock: vi.fn(async () => ({ id: 'p1' })),
  findPendingMock: vi.fn(),
  sendMessageMock: vi.fn(async () => ({})),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  findExpiredPayableOrders: vi.fn(async () => h.state.expired),
  transitionOrder: h.transitionMock,
  claimPaymentTerminal: h.claimMock,
  findPendingPaymentByOrderId: h.findPendingMock,
  getUserTelegramId: vi.fn(async () => '379000111'),
  getServiceById: vi.fn(async () => {
    if (h.state.serviceLookupError) throw h.state.serviceLookupError;
    return h.state.service;
  }),
  deleteExpiredLinkTokens: vi.fn(async () => {}),
}));

vi.mock('../telegram/bot.ts', () => ({
  getBot: () => ({ api: { sendMessage: h.sendMessageMock } }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { expirePayments } from './expire-payments.ts';

const baseOrder: OrderLike = {
  id: 'o1',
  shortId: 'ORD-7H515',
  userId: 'u1',
  serviceId: 'svc-1',
  customServiceDescription: null,
  amountRub: 245_640,
  createdAt: new Date('2026-07-19T00:30:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.expired = [];
  h.state.pendingPayment = null;
  h.state.service = { name: 'ChatGPT Plus' };
  h.state.serviceLookupError = null;
  h.findPendingMock.mockImplementation(async () => h.state.pendingPayment);
});

describe('expirePayments (T-3: оркестрация захоронения)', () => {
  it('переводит заказ в expired и шлёт человеческое уведомление без ORD-номера', async () => {
    h.state.expired = [baseOrder];

    const result = await expirePayments();

    expect(result).toEqual({ expired: 1, errors: 0 });
    expect(h.transitionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderId: 'o1', toStatus: 'expired', eventType: 'order_expired' }),
    );
    const [chatId, text] = h.sendMessageMock.mock.calls[0] as unknown as [string, string];
    expect(chatId).toBe('379000111');
    expect(text).toContain('ChatGPT Plus');
    expect(text).toContain('19 июля');
    expect(text).not.toContain('ORD-');
  });

  it('L-4: висящий pending-платёж захороненного заказа клеймится тем же проходом', async () => {
    h.state.expired = [baseOrder];
    h.state.pendingPayment = { id: 'pay-9' };

    await expirePayments();

    expect(h.claimMock).toHaveBeenCalledWith(expect.anything(), 'pay-9', expect.anything());
  });

  it('черновик без платежа → claim не зовётся', async () => {
    h.state.expired = [baseOrder];
    h.state.pendingPayment = null;

    await expirePayments();

    expect(h.claimMock).not.toHaveBeenCalled();
  });

  it('сбой лукапа сервиса не лишает клиента уведомления (fallback «заказ»)', async () => {
    h.state.expired = [baseOrder];
    h.state.serviceLookupError = new Error('db hiccup');

    const result = await expirePayments();

    expect(result.errors).toBe(0);
    const [, text] = h.sendMessageMock.mock.calls[0] as unknown as [string, string];
    expect(text).toContain('заказ');
    expect(text).toContain('/start');
  });

  it('ошибка перехода одного заказа не останавливает остальные', async () => {
    h.state.expired = [baseOrder, { ...baseOrder, id: 'o2', shortId: 'ORD-2' }];
    h.transitionMock.mockRejectedValueOnce(new Error('transition failed'));

    const result = await expirePayments();

    expect(result).toEqual({ expired: 2, errors: 1 });
    // Второй заказ дошёл до уведомления.
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
  });
});
