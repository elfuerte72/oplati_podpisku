import { beforeEach, describe, expect, it, vi } from 'vitest';

// Мокаем тяжёлые внешние зависимости ДО импорта handlers.
vi.mock('../jobs/dispatcher.ts', () => ({
  dispatchIssueCard: vi.fn(),
}));

vi.mock('@oplati/db', () => {
  const state: { payment: { id: string; orderId: string; status: string; provider: string } | null } = {
    payment: null,
  };
  return {
    getDb: () => ({}) as unknown,
    findPaymentByProviderRef: vi.fn(async () => state.payment),
    markPaymentSucceeded: vi.fn(async () => ({})),
    markPaymentStatus: vi.fn(async () => ({})),
    transitionOrder: vi.fn(async () => ({})),
    __setPayment(p: typeof state.payment) {
      state.payment = p;
    },
  };
});

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as db from '@oplati/db';
import { processInvoicePaid, processInvoiceTerminal } from './handlers.ts';
import { dispatchIssueCard } from '../jobs/dispatcher.ts';

type MockedDb = typeof db & {
  __setPayment: (
    p: { id: string; orderId: string; status: string; provider: string } | null,
  ) => void;
};

const data = {
  id: 'INV-1',
  invoiceNumber: 'INV-0001',
  amount: 100,
  currency: 'RUB',
  status: 'PAID' as const,
};

describe('processInvoicePaid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('обрабатывает первый paid и диспатчит issue-card', async () => {
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
    });

    const res = await processInvoicePaid({ data, rawPayload: { raw: 1 } });

    expect(res.kind).toBe('processed');
    expect(db.markPaymentSucceeded).toHaveBeenCalledTimes(1);
    expect(db.transitionOrder).toHaveBeenCalledTimes(1);
    expect(dispatchIssueCard).toHaveBeenCalledWith('order-1');
  });

  it('идемпотентен — повторный paid skip', async () => {
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'succeeded', // уже обработан
      provider: 'loveandpay',
    });

    const res = await processInvoicePaid({ data, rawPayload: {} });

    expect(res.kind).toBe('idempotent_skip');
    expect(db.markPaymentSucceeded).not.toHaveBeenCalled();
    expect(db.transitionOrder).not.toHaveBeenCalled();
    expect(dispatchIssueCard).not.toHaveBeenCalled();
  });

  it('не найден payment — возвращает not_found, ничего не пишет', async () => {
    (db as unknown as MockedDb).__setPayment(null);

    const res = await processInvoicePaid({ data, rawPayload: {} });

    expect(res.kind).toBe('not_found');
    expect(db.markPaymentSucceeded).not.toHaveBeenCalled();
    expect(dispatchIssueCard).not.toHaveBeenCalled();
  });
});

describe('processInvoiceTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('переводит pending → expired', async () => {
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
    });

    const res = await processInvoiceTerminal({
      data: { ...data, status: 'EXPIRED' },
      reason: 'expired',
    });

    expect(res.kind).toBe('processed');
    expect(db.markPaymentStatus).toHaveBeenCalledTimes(1);
    expect(db.transitionOrder).toHaveBeenCalledTimes(1);
  });

  it('переводит pending → cancelled', async () => {
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
    });

    const res = await processInvoiceTerminal({
      data: { ...data, status: 'CANCELLED' },
      reason: 'cancelled',
    });

    expect(res.kind).toBe('processed');
    expect(db.markPaymentStatus).toHaveBeenCalledWith(expect.anything(), 'pay-1', 'failed');
    expect(db.transitionOrder).toHaveBeenCalledTimes(1);
  });

  it('идемпотентен — повторный expired skip', async () => {
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'failed',
      provider: 'loveandpay',
    });

    const res = await processInvoiceTerminal({
      data: { ...data, status: 'EXPIRED' },
      reason: 'expired',
    });

    expect(res.kind).toBe('idempotent_skip');
    expect(db.markPaymentStatus).not.toHaveBeenCalled();
  });
});
