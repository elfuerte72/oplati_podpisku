import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

type PaymentLike = { id: string; rawPayload: Record<string, unknown> | null };

const h = vi.hoisted(() => ({
  state: {
    order: null as { id: string; userId: string; status: string } | null,
    pendingPayment: null as PaymentLike | null,
  },
  findPendingMock: vi.fn(),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  getOrderById: vi.fn(async () => h.state.order),
  findPendingPaymentByOrderId: h.findPendingMock,
  appendOrderEvent: vi.fn(async () => {}),
  findCardByIdForUser: vi.fn(async () => null),
  getOrCreateActiveConversation: vi.fn(async () => ({ id: 'c1' })),
  getServiceById: vi.fn(async () => null),
  getUserProfileById: vi.fn(async () => null),
  hasRecentOrderEvent: vi.fn(async () => false),
}));

vi.mock('../tool-handlers/confirm-order.ts', () => {
  class TelegramLinkRequiredError extends Error {}
  class PaymentProviderUnavailableError extends Error {}
  class OrderExpiredError extends Error {}
  return {
    TelegramLinkRequiredError,
    PaymentProviderUnavailableError,
    OrderExpiredError,
    confirmOrder: vi.fn(async () => ({
      paymentUrl: 'https://pay.example/new',
      qrPayload: null,
      expiresAt: '2026-07-20T00:00:00.000Z',
    })),
  };
});

vi.mock('../tool-handlers/request-human.ts', () => ({ requestHuman: vi.fn() }));
vi.mock('../catalog/propose.ts', () => ({ proposeFromCatalog: vi.fn() }));
vi.mock('../telegram/support.ts', () => ({ sendToSupportOperator: vi.fn(async () => true) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { extractInvoiceLink, payOrder } from './actions.ts';

const STORED_INVOICE = {
  invoice: {
    id: 'inv-1',
    paymentLink: 'https://pay.example/inv-1',
    qrPayload: 'sbp://qr',
    expiresAt: '2026-07-19T12:00:00.000Z',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.order = { id: 'o1', userId: 'u1', status: 'pending_payment' };
  h.state.pendingPayment = { id: 'p1', rawPayload: STORED_INVOICE };
  h.findPendingMock.mockImplementation(async () => h.state.pendingPayment);
});

describe('extractInvoiceLink (T-4)', () => {
  it('достаёт ссылку/QR/срок из сохранённого инвойса', () => {
    expect(extractInvoiceLink(STORED_INVOICE)).toEqual({
      paymentUrl: 'https://pay.example/inv-1',
      qrPayload: 'sbp://qr',
      expiresAt: '2026-07-19T12:00:00.000Z',
    });
  });

  it('null/мусор/инвойс без ссылки → null', () => {
    expect(extractInvoiceLink(null)).toBeNull();
    expect(extractInvoiceLink({ foo: 'bar' })).toBeNull();
    expect(extractInvoiceLink({ invoice: { id: 'x', paymentLink: '' } })).toBeNull();
  });
});

describe('payOrder — выставленный счёт (L-5)', () => {
  it('отдаёт ссылку строго ЖИВОГО (pending) платежа', async () => {
    const res = await payOrder('u1', 'o1');

    expect(res).toEqual({
      ok: true,
      paymentUrl: 'https://pay.example/inv-1',
      qrPayload: 'sbp://qr',
      expiresAt: '2026-07-19T12:00:00.000Z',
    });
    expect(h.findPendingMock).toHaveBeenCalledWith(expect.anything(), 'o1');
  });

  it('живого платежа нет (или без ссылки) → invoice_unavailable, а не ссылка мёртвого счёта', async () => {
    h.state.pendingPayment = null;

    const res = await payOrder('u1', 'o1');

    expect(res).toMatchObject({ ok: false, error: 'invoice_unavailable' });
  });

  it('чужой заказ → not_found (ownership)', async () => {
    const res = await payOrder('other-user', 'o1');
    expect(res).toMatchObject({ ok: false, error: 'not_found' });
  });
});
