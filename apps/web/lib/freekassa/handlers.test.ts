import { beforeEach, describe, expect, it, vi } from 'vitest';

// Тяжёлые внешние зависимости мокаем ДО импорта handlers.
vi.mock('../jobs/dispatcher.ts', () => ({
  dispatchIssueCard: vi.fn(),
  dispatchPaymentConfirmed: vi.fn(),
}));
vi.mock('../referral/accrue.ts', () => ({
  accrueReferralForPayment: vi.fn(),
}));
vi.mock('../referral/reverse.ts', () => ({
  reverseReferralAccrualsForFailedOrder: vi.fn(async () => 0),
}));
vi.mock('../alerts/notify-ops.ts', () => ({
  notifyOps: vi.fn(async () => {}),
}));

type Pay = {
  id: string;
  orderId: string;
  status: string;
  provider: string;
  providerRef: string;
  providerInvoiceNumber: string | null;
  amountRub: number;
};

vi.mock('@oplati/db', () => {
  const state: {
    byRef: Pay | null;
    byInvoiceNumber: Pay | null;
    forceClaimNull: boolean;
    forceTerminalClaimNull: boolean;
  } = {
    byRef: null,
    byInvoiceNumber: null,
    forceClaimNull: false,
    forceTerminalClaimNull: false,
  };
  return {
    // claim + transition обёрнуты в db.transaction: мок исполняет callback с
    // пустым tx (rollback-семантику проверяет PGlite-сьют packages/db).
    getDb: () => ({
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    }),
    findPaymentByProviderRef: vi.fn(async () => state.byRef),
    findPaymentByProviderInvoiceNumber: vi.fn(async () => state.byInvoiceNumber),
    claimPaymentSucceeded: vi.fn(async () => {
      if (state.forceClaimNull) return null;
      const p = state.byRef ?? state.byInvoiceNumber;
      return p && p.status === 'pending' ? { ...p, status: 'succeeded' } : null;
    }),
    claimPaymentTerminal: vi.fn(async () => {
      if (state.forceTerminalClaimNull) return null;
      const p = state.byRef ?? state.byInvoiceNumber;
      return p && p.status === 'pending' ? { ...p, status: 'failed' } : null;
    }),
    transitionOrder: vi.fn(async () => ({})),
    __setPayment(p: Pay | null, opts: { onlyByInvoiceNumber?: boolean } = {}) {
      state.byRef = opts.onlyByInvoiceNumber ? null : p;
      state.byInvoiceNumber = p;
      state.forceClaimNull = false;
      state.forceTerminalClaimNull = false;
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

import {
  freekassaNotificationSchema,
  OrderTransitionError,
  toStorableNotification,
} from '@oplati/types';

import * as db from '@oplati/db';
import { notifyOps } from '../alerts/notify-ops.ts';
import { dispatchIssueCard, dispatchPaymentConfirmed } from '../jobs/dispatcher.ts';
import { accrueReferralForPayment } from '../referral/accrue.ts';
import { reverseReferralAccrualsForFailedOrder } from '../referral/reverse.ts';
import { processFreekassaPaid, processFreekassaTerminal } from './handlers.ts';

type MockedDb = typeof db & {
  __setPayment: (p: Pay | null, opts?: { onlyByInvoiceNumber?: boolean }) => void;
  __forceClaimNull: () => void;
};

const PAYMENT: Pay = {
  id: 'pay-1',
  orderId: 'order-1',
  status: 'pending',
  provider: 'freekassa',
  providerRef: '999',
  providerInvoiceNumber: 'ORD-S3MGS-a1b2c3',
  amountRub: 249_050,
};

/**
 * Вход обработчика собирается ровно так же, как это делает роут вебхука:
 * из разобранного уведомления через `toStorableNotification` — чтобы тест
 * ловил и регресс «в raw_payload утёк PAN или подпись».
 */
function paidInput(overrides: Record<string, string> = {}) {
  const n = freekassaNotificationSchema.parse({
    MERCHANT_ID: '777',
    AMOUNT: '2490.50',
    intid: '999',
    MERCHANT_ORDER_ID: 'ORD-S3MGS-a1b2c3',
    SIGN: 'deadbeef',
    ...overrides,
  });
  return {
    intid: n.intid,
    merchantOrderId: n.MERCHANT_ORDER_ID,
    amountRaw: n.AMOUNT,
    rawPayload: toStorableNotification(n),
  };
}

describe('processFreekassaPaid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('первое уведомление: claim + переход в paid + issue-card + реферал', async () => {
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT });

    const res = await processFreekassaPaid(paidInput());

    expect(res.kind).toBe('processed');
    expect(db.claimPaymentSucceeded).toHaveBeenCalledTimes(1);
    expect(db.transitionOrder).toHaveBeenCalledTimes(1);
    expect(dispatchPaymentConfirmed).toHaveBeenCalledWith('order-1');
    expect(dispatchIssueCard).toHaveBeenCalledWith('order-1');
    expect(accrueReferralForPayment).toHaveBeenCalledWith({
      orderId: 'order-1',
      paymentId: 'pay-1',
    });
  });

  it('повтор уведомления идемпотентен: claim не выдан — побочных эффектов нет', async () => {
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT });
    (db as unknown as MockedDb).__forceClaimNull();

    const res = await processFreekassaPaid(paidInput());

    expect(res).toMatchObject({ kind: 'idempotent_skip', reason: 'already_processed' });
    expect(dispatchIssueCard).not.toHaveBeenCalled();
    expect(accrueReferralForPayment).not.toHaveBeenCalled();
  });

  it('в raw_payload платежа не уходят ни полный счёт плательщика, ни подпись', async () => {
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT });

    await processFreekassaPaid(
      paidInput({ payer_account: '4444444444444444', SIGN: 'deadbeef' }),
    );

    const call = vi.mocked(db.claimPaymentSucceeded).mock.calls[0];
    const payload = JSON.stringify(call?.[1].rawPayload);
    expect(payload).not.toContain('4444444444444444');
    expect(payload).not.toContain('deadbeef');
    expect(payload).toContain('****4444');
  });

  it('недоплата терминальна: заказ в failed, DM владельцу, карта НЕ выпускается', async () => {
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT });

    const res = await processFreekassaPaid(paidInput({ AMOUNT: '1000.00' }));

    expect(res).toMatchObject({
      kind: 'amount_mismatch',
      expectedKopecks: 249_050,
      gotKopecks: 100_000,
    });
    expect(db.claimPaymentTerminal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.transitionOrder).mock.calls[0]?.[1]).toMatchObject({
      toStatus: 'failed',
      eventType: 'payment_amount_mismatch',
    });
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(dispatchIssueCard).not.toHaveBeenCalled();
    // Заказ в failed — начисления по нему гасим (R-1), как и на пути L&P.
    expect(reverseReferralAccrualsForFailedOrder).toHaveBeenCalledWith(PAYMENT.orderId);
  });

  it('повтор недоплаты не шлёт второй DM (дедуп атомарным claim)', async () => {
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT, status: 'failed' });

    await processFreekassaPaid(paidInput({ AMOUNT: '1000.00' }));

    expect(notifyOps).not.toHaveBeenCalled();
  });

  it('переплата и копеечное округление вниз проходят как оплата', async () => {
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT });
    expect((await processFreekassaPaid(paidInput({ AMOUNT: '2500.00' }))).kind).toBe(
      'processed',
    );

    vi.clearAllMocks();
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT });
    // 2490.49 ₽ при выставленных 2490.50 ₽ — допуск 1 копейка на округление.
    expect((await processFreekassaPaid(paidInput({ AMOUNT: '2490.49' }))).kind).toBe(
      'processed',
    );
  });

  it('неразбираемая сумма останавливает fulfillment, а не «фулфилит на глазок»', async () => {
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT });

    const res = await processFreekassaPaid(paidInput({ AMOUNT: '2490.505' }));

    expect(res.kind).toBe('invalid_amount');
    expect(db.claimPaymentSucceeded).not.toHaveBeenCalled();
    expect(dispatchIssueCard).not.toHaveBeenCalled();
  });

  it('платёж не найден ни по intid, ни по MERCHANT_ORDER_ID → not_found', async () => {
    (db as unknown as MockedDb).__setPayment(null);

    const res = await processFreekassaPaid(paidInput());

    expect(res).toMatchObject({ kind: 'not_found', providerRef: '999' });
    expect(dispatchIssueCard).not.toHaveBeenCalled();
  });

  it('РЕГРЕСС: intid указал на ЧУЖОЙ платёж — подписанный номер заказа не совпал, не кредитуем', async () => {
    // Поиск идёт по `intid`, а он в MD5-подпись НЕ входит: подписаны только
    // MERCHANT_ID:AMOUNT:секрет:MERCHANT_ORDER_ID. Без сверки найденного платежа
    // с подписанным номером уведомление кредитовало бы чужой заказ.
    (db as unknown as MockedDb).__setPayment({
      ...PAYMENT,
      providerInvoiceNumber: 'ORD-OTHER-999999',
    });
    // По подписанному номеру заказа не находится ничего — то есть уведомление
    // указывает на платёж, которому оно не принадлежит.
    vi.mocked(db.findPaymentByProviderInvoiceNumber).mockResolvedValueOnce(null);

    const res = await processFreekassaPaid(paidInput());

    expect(res.kind).toBe('ref_mismatch');
    expect(db.claimPaymentSucceeded).not.toHaveBeenCalled();
    expect(db.transitionOrder).not.toHaveBeenCalled();
    expect(dispatchIssueCard).not.toHaveBeenCalled();
  });

  it('при расхождении intid побеждает ПОДПИСАННЫЙ номер заказа', async () => {
    // Нашлись оба: по intid — чужой платёж, по подписанному номеру — свой.
    // Доверяем подписанному полю, а не тому, что подделывается.
    const state = db as unknown as MockedDb;
    state.__setPayment({ ...PAYMENT }, { onlyByInvoiceNumber: true });
    vi.mocked(db.findPaymentByProviderRef).mockResolvedValueOnce({
      ...PAYMENT,
      id: 'pay-foreign',
      orderId: 'order-foreign',
      providerInvoiceNumber: 'ORD-OTHER-999999',
    } as never);

    const res = await processFreekassaPaid(paidInput());

    expect(res).toMatchObject({ kind: 'processed', paymentId: 'pay-1', orderId: 'order-1' });
  });

  it('легаси-платёж без сохранённого номера заказа сверку проходит', async () => {
    // Колонка появилась позже части платежей; ломать по ним оплату нельзя.
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT, providerInvoiceNumber: null });

    const res = await processFreekassaPaid(paidInput());

    expect(res.kind).toBe('processed');
  });

  it('intid не совпал с сохранённым orderId — платёж находится по MERCHANT_ORDER_ID', async () => {
    // Открытый вопрос контракта: равенство intid и orderId докой не обещано.
    // Запасной путь спасает оплату вместо «платёж не найден».
    (db as unknown as MockedDb).__setPayment(
      { ...PAYMENT, providerRef: '123' },
      { onlyByInvoiceNumber: true },
    );

    const res = await processFreekassaPaid(paidInput({ intid: '555' }));

    expect(res).toMatchObject({ kind: 'processed', paymentId: 'pay-1' });
    expect(db.findPaymentByProviderInvoiceNumber).toHaveBeenCalledWith(
      expect.anything(),
      'freekassa',
      'ORD-S3MGS-a1b2c3',
    );
  });

  it('оплата «мёртвого» счёта (OrderTransitionError): claim фиксируется, побочных эффектов нет', async () => {
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT });
    vi.mocked(db.transitionOrder).mockRejectedValueOnce(
      new OrderTransitionError('order-1', 'cancelled', 'paid'),
    );

    const res = await processFreekassaPaid(paidInput());

    expect(res.kind).toBe('processed');
    expect(dispatchPaymentConfirmed).not.toHaveBeenCalled();
    expect(dispatchIssueCard).not.toHaveBeenCalled();
    expect(accrueReferralForPayment).not.toHaveBeenCalled();
  });

  it('транзиентный сбой БД на переходе пробрасывается (транзакция откатит claim)', async () => {
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT });
    vi.mocked(db.transitionOrder).mockRejectedValueOnce(new Error('connection reset'));

    await expect(processFreekassaPaid(paidInput())).rejects.toThrow(
      'connection reset',
    );
    expect(dispatchIssueCard).not.toHaveBeenCalled();
  });

  it('оплата уже захороненного счёта: алёрт и DM о ручном возврате', async () => {
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT, status: 'failed' });

    const res = await processFreekassaPaid(paidInput());

    expect(res).toMatchObject({ kind: 'idempotent_skip', reason: 'paid_after_terminal' });
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(dispatchIssueCard).not.toHaveBeenCalled();
  });
});

describe('processFreekassaTerminal (добор: провайдер сказал «не оплачен»)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const terminalInput = (over: Partial<{ reason: 'cancelled' | 'failed'; providerStatus: number }> = {}) => ({
    intid: '999',
    merchantOrderId: 'ORD-S3MGS-a1b2c3',
    reason: over.reason ?? ('cancelled' as const),
    providerStatus: over.providerStatus ?? 9,
  });

  it('хоронит pending-платёж и переводит заказ в терминальный статус', async () => {
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT });

    const res = await processFreekassaTerminal(terminalInput());

    expect(res.kind).toBe('processed');
    expect(db.claimPaymentTerminal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.transitionOrder).mock.calls[0]?.[1]).toMatchObject({
      toStatus: 'cancelled',
      eventType: 'payment_cancelled',
    });
  });

  it('НЕ перезаписывает уже успешный платёж (claim вернул null)', async () => {
    // Гонка «оплата пришла вебхуком, а добор ещё видит старый статус»:
    // condition status='pending' внутри claim — источник правды, а не наше чтение.
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT, status: 'succeeded' });

    const res = await processFreekassaTerminal(terminalInput());

    expect(res).toMatchObject({ kind: 'idempotent_skip', reason: 'not_pending' });
    expect(db.transitionOrder).not.toHaveBeenCalled();
  });

  it('заказ уже ушёл иным путём (OrderTransitionError): claim фиксируется, не падаем', async () => {
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT });
    vi.mocked(db.transitionOrder).mockRejectedValueOnce(
      new OrderTransitionError('order-1', 'paid', 'cancelled'),
    );

    expect((await processFreekassaTerminal(terminalInput())).kind).toBe('processed');
  });

  it('транзиентный сбой БД пробрасывается — транзакция откатит claim', async () => {
    (db as unknown as MockedDb).__setPayment({ ...PAYMENT });
    vi.mocked(db.transitionOrder).mockRejectedValueOnce(new Error('connection reset'));

    await expect(processFreekassaTerminal(terminalInput())).rejects.toThrow('connection reset');
  });

  it('платежа нет — not_found без побочных эффектов', async () => {
    (db as unknown as MockedDb).__setPayment(null);

    expect((await processFreekassaTerminal(terminalInput())).kind).toBe('not_found');
    expect(db.claimPaymentTerminal).not.toHaveBeenCalled();
  });
});
