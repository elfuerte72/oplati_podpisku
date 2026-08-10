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
  status: string;
  expiresAt: Date | null;
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
    // Свежее состояние заказа на момент перечитывания перед claim'ом.
    // `undefined` → отдать тот же снапшот, что вернула выборка.
    freshOrder: undefined as OrderLike | null | undefined,
  },
  transitionMock: vi.fn(async () => ({})),
  claimMock: vi.fn(async () => ({ id: 'p1' })),
  findPendingMock: vi.fn(),
  getOrderByIdMock: vi.fn(),
  sendMessageMock: vi.fn(async () => ({})),
  pollOnceMock: vi.fn(async () => 'skipped' as 'recovered' | 'skipped' | 'error'),
  captureMessageMock: vi.fn(),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  findExpiredPayableOrders: vi.fn(async () => h.state.expired),
  getOrderById: h.getOrderByIdMock,
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

vi.mock('./poll-payment-one.ts', () => ({ pollPaymentOnce: h.pollOnceMock }));

vi.mock('../telegram/bot.ts', () => ({
  getBot: () => ({ api: { sendMessage: h.sendMessageMock } }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: h.captureMessageMock,
}));

import { expirePayments } from './expire-payments.ts';

const baseOrder: OrderLike = {
  id: 'o1',
  shortId: 'ORD-7H515',
  userId: 'u1',
  status: 'pending_payment',
  expiresAt: new Date('2026-07-19T01:30:00.000Z'),
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
  h.state.freshOrder = undefined;
  h.findPendingMock.mockImplementation(async () => h.state.pendingPayment);
  h.getOrderByIdMock.mockImplementation(async (_db: unknown, id: string) =>
    h.state.freshOrder === undefined ? h.state.expired.find((o) => o.id === id) : h.state.freshOrder,
  );
  h.pollOnceMock.mockResolvedValue('skipped');
});

describe('expirePayments (T-3: оркестрация захоронения)', () => {
  it('переводит заказ в expired и шлёт человеческое уведомление без ORD-номера', async () => {
    h.state.expired = [baseOrder];

    const result = await expirePayments();

    expect(result).toEqual({ expired: 1, skipped: 0, errors: 0 });
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

  it('РЕГРЕСС (HIGH): оплату в последнюю минуту TTL не хоронят — платёж сверяется со шлюзом', async () => {
    h.state.expired = [baseOrder];
    h.state.pendingPayment = { id: 'pay-9' };
    // Вебхук потерян, но шлюз показывает счёт оплаченным: pollPaymentOnce
    // проводит оплату (processInvoicePaid) и возвращает 'recovered'.
    h.pollOnceMock.mockResolvedValueOnce('recovered');

    const result = await expirePayments();

    expect(h.pollOnceMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pay-9' }),
      expect.anything(),
    );
    expect(h.claimMock).not.toHaveBeenCalled();
    expect(h.transitionMock).not.toHaveBeenCalled();
    expect(h.sendMessageMock).not.toHaveBeenCalled();
    expect(result.errors).toBe(0);
  });

  it('шлюз недоступен (error) — заказ НЕ хоронится, разберётся следующий прогон', async () => {
    h.state.expired = [{ ...baseOrder, expiresAt: new Date(Date.now() - 60_000) }];
    h.state.pendingPayment = { id: 'pay-9' };
    h.pollOnceMock.mockResolvedValueOnce('error');

    const result = await expirePayments();

    expect(h.claimMock).not.toHaveBeenCalled();
    expect(h.transitionMock).not.toHaveBeenCalled();
    // Метрика честная: выбрали 1, похоронили 0.
    expect(result).toEqual({ expired: 0, skipped: 1, errors: 0 });
  });

  it('РЕГРЕСС: сутки без подтверждения шлюза — хороним с алёртом, а не держим вечно', async () => {
    h.state.expired = [
      { ...baseOrder, expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    ];
    h.state.pendingPayment = { id: 'pay-9' };
    h.pollOnceMock.mockResolvedValueOnce('error');

    const result = await expirePayments();

    expect(h.claimMock).toHaveBeenCalled();
    expect(h.transitionMock).toHaveBeenCalled();
    expect(result.expired).toBe(1);
    expect(h.captureMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('без подтверждения шлюза'),
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('РЕГРЕСС: терминальный статус шлюза хороним СВОИМ путём — клиент получает уведомление', async () => {
    h.state.expired = [baseOrder];
    h.state.pendingPayment = { id: 'pay-9' };

    await expirePayments();

    // applyTerminal:false — иначе обработчики поллера перевели бы заказ в
    // expired молча, и ветка sendMessage ниже не выполнилась бы.
    expect(h.pollOnceMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pay-9' }),
      { applyTerminal: false },
    );
    expect(h.sendMessageMock).toHaveBeenCalled();
  });

  it('РЕГРЕСС: бюджет на сверки исчерпан — шлюз не зовём, заказы с платежом не хороним', async () => {
    // 30 заказов с висящим платежом; каждая сверка «занимает» 10 секунд —
    // так лежащий шлюз растягивал прогон на часы поверх maxDuration=300.
    h.state.expired = Array.from({ length: 30 }, (_, i) => ({ ...baseOrder, id: `o${i}` }));
    h.state.pendingPayment = { id: 'pay-9' };
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    h.pollOnceMock.mockImplementation(async () => {
      now += 10_000;
      return 'skipped';
    });

    try {
      const result = await expirePayments();

      // 60 с бюджета / 10 с на вызов = не больше 7 обращений к шлюзу.
      expect(h.pollOnceMock.mock.calls.length).toBeLessThanOrEqual(7);
      expect(result.expired).toBeLessThanOrEqual(7);
      expect(result.expired + result.skipped).toBe(30);
    } finally {
      Date.now = realNow;
    }
  });

  it('шлюз подтвердил, что счёт не оплачен — хороним как раньше', async () => {
    h.state.expired = [baseOrder];
    h.state.pendingPayment = { id: 'pay-9' };
    h.pollOnceMock.mockResolvedValueOnce('skipped');

    await expirePayments();

    expect(h.claimMock).toHaveBeenCalledWith(expect.anything(), 'pay-9', expect.anything());
    expect(h.transitionMock).toHaveBeenCalled();
  });

  it('черновик без платежа шлюз не опрашивает', async () => {
    h.state.expired = [baseOrder];
    h.state.pendingPayment = null;

    await expirePayments();

    expect(h.pollOnceMock).not.toHaveBeenCalled();
    expect(h.transitionMock).toHaveBeenCalled();
  });

  it('РЕГРЕСС: конкурентный confirm продлил expires_at — заказ пропускается', async () => {
    h.state.expired = [baseOrder];
    h.state.pendingPayment = { id: 'pay-9' };
    h.state.freshOrder = { ...baseOrder, expiresAt: new Date(Date.now() + 60 * 60 * 1000) };

    const result = await expirePayments();

    expect(h.claimMock).not.toHaveBeenCalled();
    expect(h.transitionMock).not.toHaveBeenCalled();
    expect(result.errors).toBe(0);
  });

  it('РЕГРЕСС: заказ ушёл из оплатимых статусов — заказ пропускается', async () => {
    h.state.expired = [baseOrder];
    h.state.freshOrder = { ...baseOrder, status: 'paid' };

    await expirePayments();

    expect(h.transitionMock).not.toHaveBeenCalled();
  });

  it('заказ исчез между выборкой и claim — пропускается без ошибки', async () => {
    h.state.expired = [baseOrder];
    h.state.freshOrder = null;

    const result = await expirePayments();

    expect(h.transitionMock).not.toHaveBeenCalled();
    expect(result.errors).toBe(0);
  });

  it('ошибка перехода одного заказа не останавливает остальные', async () => {
    h.state.expired = [baseOrder, { ...baseOrder, id: 'o2', shortId: 'ORD-2' }];
    h.transitionMock.mockRejectedValueOnce(new Error('transition failed'));

    const result = await expirePayments();

    expect(result).toEqual({ expired: 1, skipped: 0, errors: 1 });
    // Второй заказ дошёл до уведомления.
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
  });
});
