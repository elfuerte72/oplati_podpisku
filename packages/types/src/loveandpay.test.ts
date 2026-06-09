import { describe, expect, it } from 'vitest';

import { loveAndPayWebhookEventSchema } from './loveandpay.ts';

/**
 * Контракт webhook'а снят с живого вызова L&P (discovery 2026-06-09): событие
 * UPPER_SNAKE, тело `{ event, timestamp, data: { invoiceId, ... } }` без `currency`.
 * Схема нормализует `invoiceId -> id` и подставляет `currency = RUB`.
 */
describe('loveAndPayWebhookEventSchema', () => {
  const realPaidPayload = {
    event: 'INVOICE_PAID',
    timestamp: '2026-06-09T10:38:34.145Z',
    data: {
      invoiceId: 'example-invoice-id',
      invoiceNumber: 'INV-12345',
      amount: 150000,
      status: 'PAID',
      _test: true,
      _webhookId: 'd3f8cf68-6167-4daf-8b19-f419faed7dca',
    },
  };

  it('парсит реальный INVOICE_PAID и нормализует invoiceId -> id', () => {
    const parsed = loveAndPayWebhookEventSchema.parse(realPaidPayload);
    expect(parsed.event).toBe('INVOICE_PAID');
    expect(parsed.data.id).toBe('example-invoice-id');
    expect(parsed.data.invoiceNumber).toBe('INV-12345');
    expect(parsed.data.status).toBe('PAID');
    // currency в webhook отсутствует — подставляется RUB по умолчанию.
    expect(parsed.data.currency).toBe('RUB');
  });

  it('парсит INVOICE_EXPIRED и INVOICE_CANCELLED', () => {
    const expired = loveAndPayWebhookEventSchema.parse({
      event: 'INVOICE_EXPIRED',
      data: { invoiceId: 'i1', invoiceNumber: 'INV-1', status: 'EXPIRED' },
    });
    expect(expired.event).toBe('INVOICE_EXPIRED');

    const cancelled = loveAndPayWebhookEventSchema.parse({
      event: 'INVOICE_CANCELLED',
      data: { invoiceId: 'i2', invoiceNumber: 'INV-2', status: 'CANCELLED' },
    });
    expect(cancelled.event).toBe('INVOICE_CANCELLED');
  });

  it('отклоняет старый lowercase-формат события (invoice.paid)', () => {
    const res = loveAndPayWebhookEventSchema.safeParse({
      event: 'invoice.paid',
      data: { invoiceId: 'i', invoiceNumber: 'INV', status: 'PAID' },
    });
    expect(res.success).toBe(false);
  });
});
