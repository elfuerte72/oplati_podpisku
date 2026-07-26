import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Добор потерянных уведомлений — единственная страховка от зависшего платежа
 * (деньги списаны, заказ висит «ждёт оплаты»). До этапа 4 ТЗ цикл был захардкожен
 * на L&P (`if (payment.provider !== 'loveandpay') continue`), и платежи Freekassa
 * молча оставались без неё. Тест держит именно этот регресс.
 */

type Pay = {
  id: string;
  provider: string;
  providerRef: string;
  providerInvoiceNumber: string | null;
};

const h = vi.hoisted(() => ({
  pending: [] as Pay[],
  freekassaConfigured: true,
  paySpaceConfigured: false,
  getInvoiceMock: vi.fn(),
  findOrderMock: vi.fn(),
  // (...args: unknown[]) — чтобы `mock.calls[0][0]` был доступен в ассертах:
  // у vi.fn() без параметров тип аргументов пустой кортеж.
  lnpPaidMock: vi.fn((..._args: unknown[]) => Promise.resolve({ kind: 'processed' })),
  lnpTerminalMock: vi.fn((..._args: unknown[]) => Promise.resolve({ kind: 'processed' })),
  fkPaidMock: vi.fn((..._args: unknown[]) => Promise.resolve({ kind: 'processed' })),
  fkTerminalMock: vi.fn((..._args: unknown[]) => Promise.resolve({ kind: 'processed' })),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  findPendingPaymentsForPoll: vi.fn(async () => h.pending),
  findStuckPaidOrders: vi.fn(async () => []),
  findStuckInFulfillmentOrders: vi.fn(async () => []),
}));

vi.mock('../pay-space/index.ts', () => ({
  isPaySpaceConfigured: () => h.paySpaceConfigured,
}));

vi.mock('../freekassa/index.ts', () => ({
  isFreekassaConfigured: () => h.freekassaConfigured,
  getFreekassaClient: () => ({ findOrderByPaymentId: h.findOrderMock }),
}));

vi.mock('../freekassa/handlers.ts', () => ({
  processFreekassaPaid: h.fkPaidMock,
  processFreekassaTerminal: h.fkTerminalMock,
}));

vi.mock('../loveandpay/index.ts', () => ({
  getLoveAndPayClient: () => ({ getInvoice: h.getInvoiceMock }),
}));

vi.mock('../loveandpay/handlers.ts', () => ({
  processInvoicePaid: h.lnpPaidMock,
  processInvoiceTerminal: h.lnpTerminalMock,
  loveAndPayTerminalReason: (s: string) =>
    s === 'EXPIRED' ? 'expired' : s === 'CANCELLED' ? 'cancelled' : null,
}));

vi.mock('./proxy-health.ts', () => ({ alertOnLoveAndPayProxyDown: vi.fn(async () => {}) }));
vi.mock('./payment-conversion.ts', () => ({ alertOnZeroPaymentConversion: vi.fn(async () => {}) }));
vi.mock('./vcc-balance.ts', () => ({ alertOnLowVccBalance: vi.fn(async () => {}) }));
vi.mock('./issue-card.ts', () => ({ issueCard: vi.fn(async () => {}) }));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { pollPayments } from './poll-payment.ts';

const FK_PAYMENT: Pay = {
  id: 'pay-fk',
  provider: 'freekassa',
  providerRef: '123',
  providerInvoiceNumber: 'ORD-S3MGS-a1b2c3',
};

const LNP_PAYMENT: Pay = {
  id: 'pay-lnp',
  provider: 'loveandpay',
  providerRef: 'inv-1',
  providerInvoiceNumber: 'INV-0001',
};

function fkOrder(status: number, over: Record<string, unknown> = {}) {
  return {
    merchant_order_id: 'ORD-S3MGS-a1b2c3',
    fk_order_id: '123',
    amount: '2490.50',
    status,
    ...over,
  };
}

describe('pollPayments — добор по провайдерам', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.pending = [];
    h.freekassaConfigured = true;
    h.paySpaceConfigured = false;
    h.getInvoiceMock.mockResolvedValue({
      id: 'inv-1',
      invoiceNumber: 'INV-0001',
      amount: 100,
      currency: 'RUB',
      status: 'PENDING',
    });
    h.findOrderMock.mockResolvedValue(null);
  });

  it('оплаченный счёт Freekassa восстанавливается (уведомление потеряно)', async () => {
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(fkOrder(1));

    const res = await pollPayments();

    expect(h.fkPaidMock).toHaveBeenCalledTimes(1);
    expect(h.fkPaidMock.mock.calls[0]?.[0]).toMatchObject({
      intid: '123',
      merchantOrderId: 'ORD-S3MGS-a1b2c3',
      amountRaw: '2490.50',
      recoveredViaPolling: true,
    });
    expect(res.recovered).toBe(1);
  });

  it('ищет заказ по НАШЕМУ paymentId, а не по providerRef провайдера', async () => {
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(fkOrder(1));

    await pollPayments();

    expect(h.findOrderMock).toHaveBeenCalledWith('ORD-S3MGS-a1b2c3');
  });

  it('отменённый и ошибочный счёт хоронятся терминально', async () => {
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(fkOrder(9));
    await pollPayments();
    expect(h.fkTerminalMock.mock.calls[0]?.[0]).toMatchObject({ reason: 'cancelled' });

    vi.clearAllMocks();
    h.findOrderMock.mockResolvedValue(fkOrder(8));
    await pollPayments();
    expect(h.fkTerminalMock.mock.calls[0]?.[0]).toMatchObject({ reason: 'failed' });
  });

  it('новый (ещё не оплаченный) счёт не трогаем', async () => {
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(fkOrder(0));

    const res = await pollPayments();

    expect(h.fkPaidMock).not.toHaveBeenCalled();
    expect(h.fkTerminalMock).not.toHaveBeenCalled();
    expect(res.recovered).toBe(0);
  });

  it('заказа у провайдера нет — не хороним (это сделает expire-payments по сроку)', async () => {
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(null);

    await pollPayments();

    expect(h.fkPaidMock).not.toHaveBeenCalled();
    expect(h.fkTerminalMock).not.toHaveBeenCalled();
  });

  it('без ключей Freekassa (dev-стенд) платёж пропускается без ошибки', async () => {
    h.pending = [FK_PAYMENT];
    h.freekassaConfigured = false;

    const res = await pollPayments();

    expect(h.findOrderMock).not.toHaveBeenCalled();
    expect(res.errors).toBe(0);
  });

  it('платёж без нашего paymentId пропускается, а не роняет прогон', async () => {
    h.pending = [{ ...FK_PAYMENT, providerInvoiceNumber: null }];

    const res = await pollPayments();

    expect(h.findOrderMock).not.toHaveBeenCalled();
    expect(res.errors).toBe(0);
  });

  it('сбой опроса одного провайдера не мешает добрать платёж другого', async () => {
    // Раньше исключение на любом платеже ловилось внутри цикла — сохраняем это
    // свойство: один лежащий шлюз не должен лишать страховки второй.
    h.pending = [FK_PAYMENT, LNP_PAYMENT];
    h.findOrderMock.mockRejectedValue(new Error('freekassa down'));
    h.getInvoiceMock.mockResolvedValue({
      id: 'inv-1',
      invoiceNumber: 'INV-0001',
      amount: 100,
      currency: 'RUB',
      status: 'PAID',
    });

    const res = await pollPayments();

    expect(res.errors).toBe(1);
    expect(h.lnpPaidMock).toHaveBeenCalledTimes(1);
    expect(res.recovered).toBe(1);
  });

  it('L&P-путь не изменился: PAID восстанавливается, EXPIRED хоронится', async () => {
    h.pending = [LNP_PAYMENT];
    h.getInvoiceMock.mockResolvedValue({
      id: 'inv-1',
      invoiceNumber: 'INV-0001',
      amount: 100,
      currency: 'RUB',
      status: 'PAID',
    });
    expect((await pollPayments()).recovered).toBe(1);

    vi.clearAllMocks();
    h.getInvoiceMock.mockResolvedValue({
      id: 'inv-1',
      invoiceNumber: 'INV-0001',
      amount: 100,
      currency: 'RUB',
      status: 'EXPIRED',
    });
    await pollPayments();
    expect(h.lnpTerminalMock.mock.calls[0]?.[0]).toMatchObject({ reason: 'expired' });
  });

  it('провайдеры без добора (manual) просто пропускаются', async () => {
    h.pending = [{ id: 'pay-m', provider: 'manual', providerRef: 'x', providerInvoiceNumber: null }];

    const res = await pollPayments();

    expect(res.errors).toBe(0);
    expect(h.getInvoiceMock).not.toHaveBeenCalled();
    expect(h.findOrderMock).not.toHaveBeenCalled();
  });
});
