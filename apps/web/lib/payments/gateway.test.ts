import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  env: {
    APP_URL: 'https://www.oplatishka.com',
    PAYMENT_PRIMARY_PROVIDER: 'loveandpay',
    LOVEANDPAY_MIN_AMOUNT_RUB: 500,
    FREEKASSA_MIN_AMOUNT_RUB: 0,
    FREEKASSA_METHOD_ID: 44,
    FREEKASSA_FALLBACK_IP: '177.7.34.106',
    FREEKASSA_INVOICE_TTL_HOURS: 1,
  } as Record<string, unknown>,
  telegramId: '12345' as string | null,
  createOrderMock: vi.fn(),
  createInvoiceMock: vi.fn(),
}));

vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy({} as Record<string, unknown>, {
    get: (_target, key: string) => h.env[key],
  }),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  getUserTelegramId: vi.fn(async () => h.telegramId),
}));

vi.mock('@/lib/freekassa/index.ts', () => ({
  getFreekassaClient: () => ({ createOrder: h.createOrderMock }),
}));

vi.mock('@/lib/loveandpay/index.ts', () => {
  class LoveAndPayApiError extends Error {
    readonly code: string;
    readonly httpStatus: number;
    constructor(opts: { code: string; httpStatus: number; message: string }) {
      super(opts.message);
      this.name = 'LoveAndPayApiError';
      this.code = opts.code;
      this.httpStatus = opts.httpStatus;
    }
  }
  return {
    LoveAndPayApiError,
    getLoveAndPayClient: () => ({ createInvoice: h.createInvoiceMock }),
  };
});

import {
  createGatewayInvoice,
  minAmountRubFor,
  primaryPaymentGateway,
} from './gateway.ts';

const ORDER = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  shortId: 'ORD-S3MGS',
  amountRub: 249_050,
} as unknown as Parameters<typeof createGatewayInvoice>[0]['order'];

describe('переключатель провайдера', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.env.PAYMENT_PRIMARY_PROVIDER = 'loveandpay';
    h.telegramId = '12345';
    h.createOrderMock.mockResolvedValue({
      type: 'success',
      orderId: '123',
      orderHash: 'hash',
      location: 'https://pay.freekassa.ru/form/123/hash',
    });
    h.createInvoiceMock.mockResolvedValue({
      invoice: {
        id: 'inv-1',
        invoiceNumber: 'INV-0001',
        paymentLink: 'https://pay.example/inv-1',
        qrPayload: 'qr',
        expiresAt: '2026-07-26T12:00:00.000Z',
      },
    });
  });

  it('читает текущий шлюз из env', () => {
    expect(primaryPaymentGateway()).toBe('loveandpay');
    h.env.PAYMENT_PRIMARY_PROVIDER = 'freekassa';
    expect(primaryPaymentGateway()).toBe('freekassa');
  });

  it('минимальная сумма берётся у выбранного шлюза', () => {
    expect(minAmountRubFor('loveandpay')).toBe(500);
    // У Freekassa минимум не объявлен — гейта нет по умолчанию.
    expect(minAmountRubFor('freekassa')).toBe(0);
  });

  it('шлёт счёт ровно в один шлюз — второй не трогается', async () => {
    await createGatewayInvoice({ gateway: 'freekassa', order: ORDER, amountKopecks: 249_050 });
    expect(h.createOrderMock).toHaveBeenCalledTimes(1);
    expect(h.createInvoiceMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await createGatewayInvoice({ gateway: 'loveandpay', order: ORDER, amountKopecks: 249_050 });
    expect(h.createInvoiceMock).toHaveBeenCalledTimes(1);
    expect(h.createOrderMock).not.toHaveBeenCalled();
  });
});

describe('createGatewayInvoice — Love & Pay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createInvoiceMock.mockResolvedValue({
      invoice: {
        id: 'inv-1',
        invoiceNumber: 'INV-0001',
        paymentLink: 'https://pay.example/inv-1',
        qrPayload: 'qr',
        expiresAt: '2026-07-26T12:00:00.000Z',
      },
    });
  });

  it('нормализует ответ и сохраняет прежний конверт rawPayload', async () => {
    const invoice = await createGatewayInvoice({
      gateway: 'loveandpay',
      order: ORDER,
      amountKopecks: 249_050,
      paymentMethod: 'sbp',
    });

    expect(invoice).toMatchObject({
      provider: 'loveandpay',
      providerRef: 'inv-1',
      providerInvoiceNumber: 'INV-0001',
      paymentUrl: 'https://pay.example/inv-1',
      qrPayload: 'qr',
    });
    expect(invoice.expiresAt.toISOString()).toBe('2026-07-26T12:00:00.000Z');
    expect(h.createInvoiceMock.mock.calls[0]?.[0]).toMatchObject({
      amount: 2490.5,
      currency: 'RUB',
      paymentMethod: 'sbp',
      successUrl: 'https://www.oplatishka.com/payment-success?order=ORD-S3MGS',
    });
  });

  it('инвойс без ссылки на оплату — ошибка, а не пустой paymentUrl клиенту', async () => {
    h.createInvoiceMock.mockResolvedValue({ invoice: { id: 'inv-1', invoiceNumber: 'INV-1' } });

    await expect(
      createGatewayInvoice({ gateway: 'loveandpay', order: ORDER, amountKopecks: 249_050 }),
    ).rejects.toMatchObject({ name: 'LoveAndPayApiError' });
  });
});

describe('createGatewayInvoice — Freekassa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.telegramId = '12345';
    h.env.FREEKASSA_METHOD_ID = 44;
    h.createOrderMock.mockResolvedValue({
      type: 'success',
      orderId: '123',
      orderHash: 'hash',
      location: 'https://pay.freekassa.ru/form/123/hash',
    });
  });

  it('пишет providerRef = orderId провайдера, а provider_invoice_number = наш paymentId', async () => {
    const invoice = await createGatewayInvoice({
      gateway: 'freekassa',
      order: ORDER,
      amountKopecks: 249_050,
    });

    expect(invoice.provider).toBe('freekassa');
    expect(invoice.providerRef).toBe('123');
    // Наш идентификатор попытки: `<shortId>-<hex>` — уникален, чтобы повторное
    // выставление счёта не упёрлось в дубль на стороне провайдера, а поиск
    // платежа по MERCHANT_ORDER_ID оставался однозначным.
    expect(invoice.providerInvoiceNumber).toMatch(/^ORD-S3MGS-[0-9a-f]{6}$/);
    expect(h.createOrderMock.mock.calls[0]?.[0]).toMatchObject({
      paymentId: invoice.providerInvoiceNumber,
      amountKopecks: 249_050,
    });
  });

  it('два вызова дают разные paymentId', async () => {
    const a = await createGatewayInvoice({ gateway: 'freekassa', order: ORDER, amountKopecks: 100 });
    const b = await createGatewayInvoice({ gateway: 'freekassa', order: ORDER, amountKopecks: 100 });
    expect(a.providerInvoiceNumber).not.toBe(b.providerInvoiceNumber);
  });

  it('email — суррогат <telegram_id>@telegram.org, ip — серверный fallback', async () => {
    await createGatewayInvoice({ gateway: 'freekassa', order: ORDER, amountKopecks: 249_050 });

    expect(h.createOrderMock.mock.calls[0]?.[0]).toMatchObject({
      email: '12345@telegram.org',
      // 127.0.0.1 провайдер блокирует — шлём публичный IP узла.
      ip: '177.7.34.106',
    });
  });

  it('без telegram_id оплата не падает — используется запасной адрес', async () => {
    h.telegramId = null;

    const invoice = await createGatewayInvoice({
      gateway: 'freekassa',
      order: ORDER,
      amountKopecks: 249_050,
    });

    expect(invoice.paymentUrl).toBe('https://pay.freekassa.ru/form/123/hash');
    expect(h.createOrderMock.mock.calls[0]?.[0]).toMatchObject({
      email: 'ord-s3mgs@telegram.org',
    });
  });

  it('способ оплаты: sbp → 44, card → 36, без выбора → дефолт из env', async () => {
    await createGatewayInvoice({
      gateway: 'freekassa',
      order: ORDER,
      amountKopecks: 100,
      paymentMethod: 'sbp',
    });
    expect(h.createOrderMock.mock.calls[0]?.[0]).toMatchObject({ methodId: 44 });

    await createGatewayInvoice({
      gateway: 'freekassa',
      order: ORDER,
      amountKopecks: 100,
      paymentMethod: 'card',
    });
    expect(h.createOrderMock.mock.calls[1]?.[0]).toMatchObject({ methodId: 36 });

    h.env.FREEKASSA_METHOD_ID = 42;
    await createGatewayInvoice({ gateway: 'freekassa', order: ORDER, amountKopecks: 100 });
    expect(h.createOrderMock.mock.calls[2]?.[0]).toMatchObject({ methodId: 42 });
  });

  it('срок счёта считаем сами: провайдер его не отдаёт', async () => {
    h.env.FREEKASSA_INVOICE_TTL_HOURS = 2;
    const before = Date.now();

    const invoice = await createGatewayInvoice({
      gateway: 'freekassa',
      order: ORDER,
      amountKopecks: 100,
    });

    const deltaMs = invoice.expiresAt.getTime() - before;
    expect(deltaMs).toBeGreaterThan(2 * 60 * 60 * 1000 - 5_000);
    expect(deltaMs).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 5_000);
    h.env.FREEKASSA_INVOICE_TTL_HOURS = 1;
  });

  it('rawPayload использует ОБЩИЙ конверт invoice — иначе повторный confirm не найдёт ссылку', async () => {
    const invoice = await createGatewayInvoice({
      gateway: 'freekassa',
      order: ORDER,
      amountKopecks: 249_050,
    });

    expect(invoice.rawPayload).toMatchObject({
      invoice: {
        id: '123',
        paymentLink: 'https://pay.freekassa.ru/form/123/hash',
      },
      provider: 'freekassa',
    });
  });
});
