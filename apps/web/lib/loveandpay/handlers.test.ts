import { beforeEach, describe, expect, it, vi } from 'vitest';

// Мокаем тяжёлые внешние зависимости ДО импорта handlers.
vi.mock('../jobs/dispatcher.ts', () => ({
  dispatchIssueCard: vi.fn(),
  dispatchPaymentConfirmed: vi.fn(),
}));

type Pay = {
  id: string;
  orderId: string;
  status: string;
  provider: string;
  amountRub?: number;
};

vi.mock('@oplati/db', () => {
  const state: { payment: Pay | null; forceClaimNull: boolean } = {
    payment: null,
    forceClaimNull: false,
  };
  return {
    getDb: () => ({}) as unknown,
    findPaymentByProviderRef: vi.fn(async () => state.payment),
    // Атомарный claim: возвращает строку только если платёж был pending и claim
    // не форсирован в null (моделирует проигрыш гонки другому вызову).
    claimPaymentSucceeded: vi.fn(async () => {
      if (state.forceClaimNull) return null;
      if (state.payment && state.payment.status === 'pending') {
        return { ...state.payment, status: 'succeeded' };
      }
      return null;
    }),
    markPaymentStatus: vi.fn(async () => ({})),
    transitionOrder: vi.fn(async () => ({})),
    __setPayment(p: Pay | null) {
      state.payment = p;
      state.forceClaimNull = false;
    },
    __forceClaimNull() {
      state.forceClaimNull = true;
    },
  };
});

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as db from '@oplati/db';
import { processInvoicePaid, processInvoiceTerminal } from './handlers.ts';
import { dispatchIssueCard, dispatchPaymentConfirmed } from '../jobs/dispatcher.ts';

type MockedDb = typeof db & {
  __setPayment: (p: Pay | null) => void;
  __forceClaimNull: () => void;
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

  it('обрабатывает первый paid (claim успешен) и диспатчит issue-card', async () => {
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
    });

    const res = await processInvoicePaid({ data, rawPayload: { raw: 1 } });

    expect(res.kind).toBe('processed');
    expect(db.claimPaymentSucceeded).toHaveBeenCalledTimes(1);
    expect(db.transitionOrder).toHaveBeenCalledTimes(1);
    expect(dispatchIssueCard).toHaveBeenCalledWith('order-1');
    expect(dispatchPaymentConfirmed).toHaveBeenCalledWith('order-1');
  });

  it('идемпотентен — повторный paid (платёж уже succeeded) skip', async () => {
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'succeeded', // уже обработан
      provider: 'loveandpay',
    });

    const res = await processInvoicePaid({ data, rawPayload: {} });

    expect(res.kind).toBe('idempotent_skip');
    expect(db.transitionOrder).not.toHaveBeenCalled();
    expect(dispatchIssueCard).not.toHaveBeenCalled();
    expect(dispatchPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('гонка webhook ↔ poll: claim вернул null (другой вызов успел) → НЕ диспатчит issue-card', async () => {
    // Платёж ещё pending, но claim проигран конкурентному вызову.
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
    });
    (db as unknown as MockedDb).__forceClaimNull();

    const res = await processInvoicePaid({ data, rawPayload: {} });

    expect(res.kind).toBe('idempotent_skip');
    expect(db.claimPaymentSucceeded).toHaveBeenCalledTimes(1);
    // Главное: побочные эффекты НЕ выполняются → нет двойного топ-апа карты.
    expect(db.transitionOrder).not.toHaveBeenCalled();
    expect(dispatchIssueCard).not.toHaveBeenCalled();
    expect(dispatchPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('не найден payment — возвращает not_found, ничего не пишет', async () => {
    (db as unknown as MockedDb).__setPayment(null);

    const res = await processInvoicePaid({ data, rawPayload: {} });

    expect(res.kind).toBe('not_found');
    expect(db.claimPaymentSucceeded).not.toHaveBeenCalled();
    expect(dispatchIssueCard).not.toHaveBeenCalled();
  });

  it('оплачено меньше выставленного → amount_mismatch, fulfillment НЕ запускается', async () => {
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
      amountRub: 10000, // выставлено 100 ₽
    });

    // L&P шлёт amount в рублях; оплачено 80 ₽ при выставленных 100 ₽.
    const res = await processInvoicePaid({ data: { ...data, amount: 80 }, rawPayload: {} });

    expect(res.kind).toBe('amount_mismatch');
    // Не клеймим платёж и не запускаем выпуск карты на полную сумму.
    expect(db.claimPaymentSucceeded).not.toHaveBeenCalled();
    expect(db.transitionOrder).not.toHaveBeenCalled();
    expect(dispatchIssueCard).not.toHaveBeenCalled();
  });

  it('amount=0 в webhook (поле опционально) → сверку пропускаем, обрабатываем как обычно', async () => {
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
      amountRub: 10000,
    });

    const res = await processInvoicePaid({ data: { ...data, amount: 0 }, rawPayload: {} });

    expect(res.kind).toBe('processed');
    expect(dispatchIssueCard).toHaveBeenCalledWith('order-1');
  });

  it('точная оплата (amount == сумма заказа) → обрабатываем нормально', async () => {
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
      amountRub: 10000, // 100 ₽
    });

    const res = await processInvoicePaid({ data: { ...data, amount: 100 }, rawPayload: {} });

    expect(res.kind).toBe('processed');
    expect(dispatchIssueCard).toHaveBeenCalledWith('order-1');
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
