import { beforeEach, describe, expect, it, vi } from 'vitest';

// Мокаем тяжёлые внешние зависимости ДО импорта handlers.
vi.mock('../jobs/dispatcher.ts', () => ({
  dispatchIssueCard: vi.fn(),
  dispatchPaymentConfirmed: vi.fn(),
}));
// Реферальные начисления тестируются отдельно (referral/accrue.test.ts) — здесь
// no-op, чтобы тест webhook оставался сфокусированным на платёжном пути.
vi.mock('../referral/accrue.ts', () => ({
  accrueReferralForPayment: vi.fn(),
}));
// DM владельцу при недоплате (M-3) — мокаем, чтобы не тянуть grammY-бота.
vi.mock('../alerts/notify-ops.ts', () => ({
  notifyOps: vi.fn(async () => {}),
}));

type Pay = {
  id: string;
  orderId: string;
  status: string;
  provider: string;
  amountRub?: number;
};

vi.mock('@oplati/db', () => {
  const state: {
    payment: Pay | null;
    forceClaimNull: boolean;
    forceTerminalClaimNull: boolean;
  } = {
    payment: null,
    forceClaimNull: false,
    forceTerminalClaimNull: false,
  };
  return {
    // processInvoicePaid оборачивает claim+transition в db.transaction: мок
    // просто исполняет callback с пустым tx (rollback-семантику проверяет
    // интеграционный сьют packages/db на реальном Postgres).
    getDb: () => ({
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    }),
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
    // Атомарный claim в terminal (pending→failed): строку возвращает только если
    // платёж был pending и claim не форсирован в null (моделирует проигрыш гонки
    // paid-пути между чтением payment и условным UPDATE).
    claimPaymentTerminal: vi.fn(async () => {
      if (state.forceTerminalClaimNull) return null;
      if (state.payment && state.payment.status === 'pending') {
        return { ...state.payment, status: 'failed' };
      }
      return null;
    }),
    transitionOrder: vi.fn(async () => ({})),
    __setPayment(p: Pay | null) {
      state.payment = p;
      state.forceClaimNull = false;
      state.forceTerminalClaimNull = false;
    },
    __forceClaimNull() {
      state.forceClaimNull = true;
    },
    __forceTerminalClaimNull() {
      state.forceTerminalClaimNull = true;
    },
  };
});

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { OrderTransitionError } from '@oplati/types';

import * as db from '@oplati/db';
import { processInvoicePaid, processInvoiceTerminal } from './handlers.ts';
import { dispatchIssueCard, dispatchPaymentConfirmed } from '../jobs/dispatcher.ts';
import { notifyOps } from '../alerts/notify-ops.ts';
import { accrueReferralForPayment } from '../referral/accrue.ts';

type MockedDb = typeof db & {
  __setPayment: (p: Pay | null) => void;
  __forceClaimNull: () => void;
  __forceTerminalClaimNull: () => void;
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

  it('начисляет реферал при успешном переходе в paid', async () => {
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
    });
    await processInvoicePaid({ data, rawPayload: {} });
    expect(accrueReferralForPayment).toHaveBeenCalledWith({ orderId: 'order-1', paymentId: 'pay-1' });
  });

  it('оплата «мёртвого» счёта (OrderTransitionError): claim фиксируется, но НИ уведомление, НИ issue-card, НИ реферал не запускаются', async () => {
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
    });
    // Заказ в терминальном статусе → transitionOrder бросает ТИПИЗИРОВАННУЮ
    // ошибку машины статусов → paidOk=false, аномалия алертится.
    vi.mocked(db.transitionOrder).mockRejectedValueOnce(
      new OrderTransitionError('order-1', 'cancelled', 'paid'),
    );

    const res = await processInvoicePaid({ data, rawPayload: {} });

    expect(res.kind).toBe('processed');
    expect(accrueReferralForPayment).not.toHaveBeenCalled();
    // Находка аудита I4: раньше «Оплата получена, обрабатываем» уходило клиенту
    // даже когда заказ мёртв и обработка не начнётся.
    expect(dispatchPaymentConfirmed).not.toHaveBeenCalled();
    expect(dispatchIssueCard).not.toHaveBeenCalled();
  });

  it('транзиентный сбой БД на переходе в paid: ошибка пробрасывается (транзакция откатит claim), побочных эффектов нет', async () => {
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
    });
    // НЕ OrderTransitionError — например, обрыв соединения к pooler'у. Раньше
    // такой сбой «съедался»: payment оставался succeeded при неоплаченном
    // заказе, и ни один recovery его не подбирал (находка аудита C1).
    vi.mocked(db.transitionOrder).mockRejectedValueOnce(new Error('connection reset'));

    await expect(processInvoicePaid({ data, rawPayload: {} })).rejects.toThrow('connection reset');

    expect(dispatchPaymentConfirmed).not.toHaveBeenCalled();
    expect(dispatchIssueCard).not.toHaveBeenCalled();
    expect(accrueReferralForPayment).not.toHaveBeenCalled();
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

  it('оплачено меньше выставленного → amount_mismatch: платёж failed, заказ failed, DM оператору, fulfillment НЕ запускается (M-3)', async () => {
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
    // Успешный claim НЕ выполняется (карта не выпускается на полную сумму) —
    // вместо него терминальный: раньше платёж вечно висел pending (poll
    // ре-алертил 25 ч), а заказ позже хоронился как «срок истёк» при частично
    // принятых деньгах.
    expect(db.claimPaymentSucceeded).not.toHaveBeenCalled();
    expect(db.claimPaymentTerminal).toHaveBeenCalledTimes(1);
    expect(db.transitionOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'failed', eventType: 'payment_amount_mismatch' }),
    );
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(dispatchIssueCard).not.toHaveBeenCalled();
  });

  it('повтор webhook после amount_mismatch → терминальный claim null → DM не дублируется', async () => {
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
      amountRub: 10000,
    });
    (db as unknown as MockedDb).__forceTerminalClaimNull();

    const res = await processInvoicePaid({ data: { ...data, amount: 80 }, rawPayload: {} });

    expect(res.kind).toBe('amount_mismatch');
    expect(notifyOps).not.toHaveBeenCalled();
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
    expect(db.claimPaymentTerminal).toHaveBeenCalledTimes(1);
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
    expect(db.claimPaymentTerminal).toHaveBeenCalledWith(expect.anything(), 'pay-1', expect.anything());
    expect(db.transitionOrder).toHaveBeenCalledTimes(1);
  });

  it('идемпотентен — повторный expired skip (платёж уже failed)', async () => {
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
    expect(db.transitionOrder).not.toHaveBeenCalled();
  });

  it('M4: гонку выиграл paid-путь (claim вернул null) → skip без перезаписи succeeded', async () => {
    // Платёж прочитан как pending, но между чтением и атомарным claim paid-путь
    // конкурентно перевёл его в succeeded (карта уже выпущена). claim не находит
    // pending → null. Мы НЕ перезаписываем succeeded→failed и не трогаем заказ.
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
    });
    (db as unknown as MockedDb).__forceTerminalClaimNull();

    const res = await processInvoiceTerminal({
      data: { ...data, status: 'EXPIRED' },
      reason: 'expired',
    });

    expect(res.kind).toBe('idempotent_skip');
    expect(db.claimPaymentTerminal).toHaveBeenCalledTimes(1);
    expect(db.transitionOrder).not.toHaveBeenCalled();
  });

  it('F-05: OrderTransitionError на переходе НЕ роняет обработку (claim фиксируется)', async () => {
    // Легитимная гонка: заказ уже истёк по cron (expired→expired запрещён).
    // Платёж должен остаться failed (claim закоммичен), результат — processed.
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
    });
    vi.mocked(db.transitionOrder).mockRejectedValueOnce(
      new OrderTransitionError('order-1', 'expired', 'expired'),
    );

    const res = await processInvoiceTerminal({
      data: { ...data, status: 'EXPIRED' },
      reason: 'expired',
    });

    expect(res.kind).toBe('processed');
  });

  it('F-05: транзиентный сбой на переходе пробрасывается (транзакция откатит claim)', async () => {
    // Обрыв соединения — НЕ бизнес-аномалия: re-throw из transaction-callback
    // откатывает и claim, платёж остаётся pending, ретрай L&P/poll доиграет оба
    // шага. Граница webhook'а ловит throw → 200 OK (инвариант №6).
    (db as unknown as MockedDb).__setPayment({
      id: 'pay-1',
      orderId: 'order-1',
      status: 'pending',
      provider: 'loveandpay',
    });
    vi.mocked(db.transitionOrder).mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      processInvoiceTerminal({ data: { ...data, status: 'EXPIRED' }, reason: 'expired' }),
    ).rejects.toThrow('connection reset');
  });
});
