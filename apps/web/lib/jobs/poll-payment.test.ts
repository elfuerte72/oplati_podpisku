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
  loveAndPayConfigured: { value: true },
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
  isLoveAndPayConfigured: () => h.loveAndPayConfigured.value,
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
    h.loveAndPayConfigured.value = true;
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

  it('РЕГРЕСС: ключей L&P нет — «опрашивать нечем», а не ошибка на каждый платёж', async () => {
    // Гейт симметричен isFreekassaConfigured. Без него getLoveAndPayClient()
    // бросал, и для expire-payments это означало «статус неизвестен» → заказ
    // не хоронится никогда (находка ревью).
    h.pending = [LNP_PAYMENT];
    h.loveAndPayConfigured.value = false;

    const res = await pollPayments();

    expect(res.errors).toBe(0);
    expect(res.recovered).toBe(0);
    expect(h.getInvoiceMock).not.toHaveBeenCalled();
  });

  it('провайдеры без добора (manual) просто пропускаются', async () => {
    h.pending = [{ id: 'pay-m', provider: 'manual', providerRef: 'x', providerInvoiceNumber: null }];

    const res = await pollPayments();

    expect(res.errors).toBe(0);
    expect(h.getInvoiceMock).not.toHaveBeenCalled();
    expect(h.findOrderMock).not.toHaveBeenCalled();
  });
  it('порядок nonce делегирован клиенту — крон гонит все платежи одним пулом', async () => {
    // Раньше freekassa-платежи отделялись и гнались с concurrency=1: очередь
    // жила здесь. Теперь очередь внутри FreekassaClient (`serialized`), потому
    // что потребителей API стало двое. Здесь остаётся проверить, что ни один
    // платёж не потерян, а порядок nonce покрыт тестом клиента.
    h.pending = Array.from({ length: 8 }, (_, i) => ({
      id: `pay-${i}`,
      provider: 'freekassa' as const,
      providerRef: String(i),
      providerInvoiceNumber: `ORD-${i}`,
    }));
    h.findOrderMock.mockResolvedValue(null);

    const res = await pollPayments();

    expect(h.findOrderMock).toHaveBeenCalledTimes(8);
    expect(res.processed).toBe(8);
    expect(res.errors).toBe(0);
  });

  it('РЕГРЕСС: медленные freekassa-опросы не задерживают добор Love&Pay', async () => {
    // Две последовательные очереди означали, что бэклог одного шлюза съедает
    // шаг крона другого — ровно тот отказ, ради которого пул и появился.
    h.pending = [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `pay-fk-${i}`,
        provider: 'freekassa' as const,
        providerRef: String(i),
        providerInvoiceNumber: `ORD-${i}`,
      })),
      {
        id: 'pay-lnp',
        provider: 'loveandpay' as const,
        providerRef: 'inv-1',
        providerInvoiceNumber: null,
      },
    ];
    let lnpStartedAt = Number.POSITIVE_INFINITY;
    const startedAt = Date.now();
    h.findOrderMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return null;
    });
    h.getInvoiceMock.mockImplementation(async () => {
      lnpStartedAt = Date.now();
      return { id: 'inv-1', invoiceNumber: 'INV-1', amount: 100, currency: 'RUB', status: 'NEW' };
    });

    await pollPayments();

    // L&P стартовал, не дожидаясь всей пачки freekassa (4 × 30 мс).
    expect(lnpStartedAt - startedAt).toBeLessThan(60);
  });

  it('Love&Pay опрашивается параллельно, но не более POLL_CONCURRENCY разом', async () => {
    // У L&P nonce нет, ограничивать порядок нечем — здесь параллелизм безопасен
    // и даёт весь выигрыш: последовательный цикл не влезал в шаг крона.
    h.pending = Array.from({ length: 12 }, (_, i) => ({
      id: `pay-lnp-${i}`,
      provider: 'loveandpay' as const,
      providerRef: `inv-${i}`,
      providerInvoiceNumber: `INV-${i}`,
    }));

    let inFlight = 0;
    let peak = 0;
    h.getInvoiceMock.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3));
      inFlight--;
      return {
        id: 'inv-1',
        invoiceNumber: 'INV-0001',
        amount: 100,
        currency: 'RUB',
        status: 'PENDING',
      };
    });

    await pollPayments();

    expect(h.getInvoiceMock).toHaveBeenCalledTimes(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('падение одного платежа не уносит остальную пачку', async () => {
    h.pending = [FK_PAYMENT, { ...FK_PAYMENT, id: 'pay-fk-2', providerRef: '124' }];
    h.findOrderMock
      .mockRejectedValueOnce(new Error('провайдер отвалился'))
      .mockResolvedValueOnce(fkOrder(1));

    const res = await pollPayments();

    expect(res.errors).toBe(1);
    // Второй платёж всё равно обработан — воркер пула не умер вместе с первым.
    expect(h.findOrderMock).toHaveBeenCalledTimes(2);
  });
});
