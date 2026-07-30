import { describe, expect, it } from 'vitest';

import { loveAndPayInvoiceResponseSchema, loveAndPayWebhookEventSchema } from './loveandpay.ts';

/**
 * Контракт снят с РЕАЛЬНОГО платежа L&P (discovery 2026-06-09):
 *   тело `{ id, event: "invoice.paid", data: { id, invoiceNumber, amount, currency, status } }`.
 * Вкладка «Тестирование» кабинета шлёт ДРУГОЙ формат (`INVOICE_PAID`, `data.invoiceId`,
 * без `currency`) — схема нормализует оба к каноническому виду.
 */
describe('loveAndPayWebhookEventSchema', () => {
  // Точный payload реального вебхука (из логов dev, ORD-P8S1F).
  const realPaidPayload = {
    id: 'evt_1781002744291_cd807734dc51',
    event: 'invoice.paid',
    timestamp: '2026-06-09T10:59:04.291Z',
    data: {
      id: 'a2ee2016-f048-40a9-b57b-555e9b60523b',
      invoiceNumber: 'INV-1781002602464-47705e4b5bca',
      amount: 2090,
      currency: 'RUB',
      status: 'PAID',
      customerEmail: null,
      customerName: null,
      paidAt: '2026-06-09T10:59:04.265Z',
      transactionId: '2dcb09c0-1158-48e9-b7b6-27f34d373daf',
    },
    partnerId: 'e9c4b068-335a-43c3-a007-8bf3cc6b4943',
    retryCount: 0,
  };

  it('парсит реальный invoice.paid (прод-формат)', () => {
    const parsed = loveAndPayWebhookEventSchema.parse(realPaidPayload);
    expect(parsed.event).toBe('invoice.paid');
    expect(parsed.data.id).toBe('a2ee2016-f048-40a9-b57b-555e9b60523b');
    expect(parsed.data.invoiceNumber).toBe('INV-1781002602464-47705e4b5bca');
    expect(parsed.data.status).toBe('PAID');
    expect(parsed.data.currency).toBe('RUB');
  });

  /**
   * Новая платформа (кабинет → Вебхуки, 2026-07-29) шлёт рядом с `amount` ещё
   * `amountKopecks`/`amountRub` и предупреждает, что сам `amount` неоднозначен:
   * копейки в `invoice.created`, рубли в остальных событиях. Недоплата у нас
   * терминальна, поэтому сверка обязана опираться на однозначное поле.
   */
  it('берёт копейки из amountKopecks, когда провайдер их прислал', () => {
    const parsed = loveAndPayWebhookEventSchema.parse({
      ...realPaidPayload,
      data: { ...realPaidPayload.data, amount: 4318.19, amountKopecks: 431819, amountRub: 4318.19 },
    });
    expect(parsed.data.amountKopecks).toBe(431819);
  });

  it('считает копейки из amountRub, если целого поля нет', () => {
    const parsed = loveAndPayWebhookEventSchema.parse({
      ...realPaidPayload,
      data: { ...realPaidPayload.data, amount: 4318.19, amountRub: 4318.19 },
    });
    expect(parsed.data.amountKopecks).toBe(431819);
  });

  it.each([
    ['ноль копеек', { amountKopecks: 0 }],
    ['отрицательные копейки', { amountKopecks: -100 }],
    ['дробные копейки', { amountKopecks: 12.5 }],
    ['рубли, округляющиеся в ноль', { amountRub: 0.004 }],
    ['отрицательные рубли', { amountRub: -10 }],
  ])('не выдаёт мусор за точную сумму: %s', (_name, patch) => {
    const parsed = loveAndPayWebhookEventSchema.parse({
      ...realPaidPayload,
      data: { ...realPaidPayload.data, ...patch },
    });
    // Фальшивый ноль опаснее отсутствия: гейт недоплаты пропускает нулевую сверку.
    expect(parsed.data.amountKopecks).toBeUndefined();
  });

  it('оставляет amountKopecks пустым на легаси-теле — потребитель падает на amount', () => {
    const parsed = loveAndPayWebhookEventSchema.parse(realPaidPayload);
    expect(parsed.data.amountKopecks).toBeUndefined();
    expect(parsed.data.amount).toBe(2090);
  });

  it('нормализует тестовый формат панели (INVOICE_PAID / invoiceId / без currency)', () => {
    const parsed = loveAndPayWebhookEventSchema.parse({
      event: 'INVOICE_PAID',
      timestamp: '2026-06-09T10:38:34.145Z',
      data: { invoiceId: 'example-invoice-id', invoiceNumber: 'INV-12345', amount: 150000, status: 'PAID' },
    });
    expect(parsed.event).toBe('invoice.paid');
    expect(parsed.data.id).toBe('example-invoice-id');
    expect(parsed.data.currency).toBe('RUB'); // дефолт, в теле отсутствует
  });

  it('парсит invoice.expired и invoice.cancelled', () => {
    const expired = loveAndPayWebhookEventSchema.parse({
      event: 'invoice.expired',
      data: { id: 'i1', invoiceNumber: 'INV-1', status: 'EXPIRED' },
    });
    expect(expired.event).toBe('invoice.expired');

    const cancelled = loveAndPayWebhookEventSchema.parse({
      event: 'INVOICE_CANCELLED',
      data: { invoiceId: 'i2', invoiceNumber: 'INV-2', status: 'CANCELLED' },
    });
    expect(cancelled.event).toBe('invoice.cancelled');
  });

  it('отклоняет data без id и invoiceId (пустой id сломал бы идемпотентность)', () => {
    const res = loveAndPayWebhookEventSchema.safeParse({
      event: 'invoice.paid',
      data: { invoiceNumber: 'INV-3', status: 'PAID' },
    });
    expect(res.success).toBe(false);
  });

  it('отклоняет неизвестное событие', () => {
    const res = loveAndPayWebhookEventSchema.safeParse({
      event: 'invoice.refunded',
      data: { id: 'i', invoiceNumber: 'INV', status: 'PAID' },
    });
    expect(res.success).toBe(false);
  });
});

/**
 * Регрессия: GET /invoices/{id} (проверка статуса, polling-recovery в cron
 * poll-payment) НЕ возвращает `paymentLink` — оно есть только в ответе на
 * создание инвойса. Раньше схема требовала paymentLink → каждый прогон падал с
 * LoveAndPayContractError (подтверждено в проде, balanceUsdCents-логи). Теперь
 * поле optional, статус-ответ парсится.
 */
describe('loveAndPayInvoiceResponseSchema (status vs create)', () => {
  it('парсит ответ на проверку статуса БЕЗ paymentLink', () => {
    const statusResponse = {
      success: true,
      invoice: {
        id: 'a2ee2016-f048-40a9-b57b-555e9b60523b',
        invoiceNumber: 'INV-1781002602464-47705e4b5bca',
        amount: 2090,
        currency: 'RUB',
        status: 'PAID',
        expiresAt: '2026-06-09T11:59:04.291Z',
      },
    };
    const parsed = loveAndPayInvoiceResponseSchema.parse(statusResponse);
    expect(parsed.invoice.status).toBe('PAID');
    expect(parsed.invoice.paymentLink).toBeUndefined();
  });

  it('по-прежнему принимает paymentLink, когда он есть (ответ на создание)', () => {
    const createResponse = {
      success: true,
      invoice: {
        id: 'i1',
        invoiceNumber: 'INV-1',
        amount: 2090,
        currency: 'RUB',
        status: 'PENDING',
        expiresAt: '2026-06-09T11:59:04.291Z',
        paymentLink: 'https://pay.example.com/i1',
      },
    };
    const parsed = loveAndPayInvoiceResponseSchema.parse(createResponse);
    expect(parsed.invoice.paymentLink).toBe('https://pay.example.com/i1');
  });
});
