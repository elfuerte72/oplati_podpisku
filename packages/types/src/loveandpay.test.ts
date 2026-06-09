import { describe, expect, it } from 'vitest';

import { loveAndPayWebhookEventSchema } from './loveandpay.ts';

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

  it('отклоняет неизвестное событие', () => {
    const res = loveAndPayWebhookEventSchema.safeParse({
      event: 'invoice.refunded',
      data: { id: 'i', invoiceNumber: 'INV', status: 'PAID' },
    });
    expect(res.success).toBe(false);
  });
});
