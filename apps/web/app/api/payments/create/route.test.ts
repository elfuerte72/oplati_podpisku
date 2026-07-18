import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.INTERNAL_API_TOKEN = 'test-internal-token';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

type OrderLike = {
  id: string;
  shortId: string;
  status: string;
  amountRub: number;
  expiresAt: Date | null;
};

const h = vi.hoisted(() => ({
  // Сентинел транзакции: ассертим, что репо-функции получают именно его,
  // а не внешний db — это и есть гарантия «в одной транзакции» (M-2).
  txSentinel: { __tag: 'tx' } as object,
  transactionMock: vi.fn(),
  upsertMock: vi.fn(),
  transitionMock: vi.fn(async () => ({})),
  setExpiresMock: vi.fn(async () => {}),
  state: { order: null as OrderLike | null },
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({ transaction: h.transactionMock }),
  getOrderById: vi.fn(async () => h.state.order),
  upsertPaymentByProviderRef: h.upsertMock,
  transitionOrder: h.transitionMock,
  setOrderExpiresAt: h.setExpiresMock,
  findPendingPaymentByOrderId: vi.fn(async () => null),
}));

vi.mock('@/lib/loveandpay', () => {
  class LoveAndPayApiError extends Error {
    readonly code: string;
    readonly httpStatus: number;
    constructor(opts: { code: string; httpStatus: number; message: string }) {
      super(opts.message);
      this.code = opts.code;
      this.httpStatus = opts.httpStatus;
    }
  }
  return {
    LoveAndPayApiError,
    getLoveAndPayClient: () => ({
      createInvoice: vi.fn(async () => ({
        invoice: {
          id: 'inv-1',
          invoiceNumber: 'INV-0001',
          paymentLink: 'https://pay.example/inv-1',
          qrPayload: null,
          expiresAt: '2026-07-19T00:00:00.000Z',
        },
      })),
    }),
  };
});

// Healthcheck прокси тянет notify-ops → grammY — в юнитах не нужен.
vi.mock('@/lib/jobs/proxy-health', () => ({
  alertOnLoveAndPayProxyDown: vi.fn(async () => {}),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { POST } from './route.ts';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/payments/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': 'test-internal-token',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.order = {
    id: ORDER_ID,
    shortId: 'AB12',
    status: 'ready_for_payment',
    amountRub: 100_000, // 1000 ₽ — выше минимума терминала 500 ₽
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
  // Транзакция исполняет callback с сентинелом (rollback-семантику проверяет
  // интеграционный сьют packages/db на реальном Postgres).
  h.transactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(h.txSentinel),
  );
  h.upsertMock.mockImplementation(async () => ({
    isNew: true,
    payment: { id: 'pay-1' },
  }));
});

describe('POST /api/payments/create — атомарность записи платежа и перехода (M-2)', () => {
  it('upsert платежа, переход заказа и выравнивание срока идут В ОДНОЙ транзакции', async () => {
    const resp = await POST(makeRequest({ orderId: ORDER_ID }));
    const json = (await resp.json()) as { ok: boolean; paymentUrl: string; expiresAt: string };

    expect(resp.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.paymentUrl).toBe('https://pay.example/inv-1');
    expect(json.expiresAt).toBe('2026-07-19T00:00:00.000Z');

    // Сбой БД между INSERT платежа и переходом раньше оставлял живой L&P-инвойс
    // при заказе в ready_for_payment (аудит M-2) — теперь все три операции
    // обязаны получить ОДИН транзакционный хендл.
    expect(h.transactionMock).toHaveBeenCalledTimes(1);
    expect(h.upsertMock).toHaveBeenCalledWith(h.txSentinel, expect.anything());
    expect(h.transitionMock).toHaveBeenCalledWith(
      h.txSentinel,
      expect.objectContaining({ orderId: ORDER_ID, toStatus: 'pending_payment' }),
    );
    expect(h.setExpiresMock).toHaveBeenCalledWith(
      h.txSentinel,
      ORDER_ID,
      new Date('2026-07-19T00:00:00.000Z'),
    );
  });

  it('дубль (isNew=false) — переход и выравнивание срока не выполняются', async () => {
    h.upsertMock.mockImplementation(async () => ({ isNew: false, payment: { id: 'pay-1' } }));

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));

    expect(resp.status).toBe(200);
    expect(h.transitionMock).not.toHaveBeenCalled();
    expect(h.setExpiresMock).not.toHaveBeenCalled();
  });

  it('протухшая фиксация цены → 409 order_expired, счёт в L&P не создаётся', async () => {
    h.state.order = { ...h.state.order!, expiresAt: new Date(Date.now() - 1000) };

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));
    const json = (await resp.json()) as { error: string };

    expect(resp.status).toBe(409);
    expect(json.error).toBe('order_expired');
    expect(h.upsertMock).not.toHaveBeenCalled();
    // Захоронение протухшего черновика — вне платёжной транзакции (её ещё нет).
    expect(h.transitionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'expired', eventType: 'order_expired' }),
    );
  });
});
