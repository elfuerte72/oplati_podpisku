import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Вебхук L&P без секрета проглатывал платёжное событие МОЛЧА (только log.warn):
 * провайдер считал доставку успешной, ретраев не было, а в наблюдаемости —
 * ничего (аудит 2026-08-10). Симметричный путь Freekassa в том же кейсе
 * алёртит; тест держит эту симметрию.
 */

const h = vi.hoisted(() => ({
  captureMessageMock: vi.fn(),
  env: {
    LOVEANDPAY_WEBHOOK_SECRET: undefined as string | undefined,
  } as Record<string, unknown>,
}));

vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy({} as Record<string, unknown>, {
    get: (_target, key: string) => h.env[key],
  }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: h.captureMessageMock,
}));

vi.mock('@/lib/loveandpay/handlers', () => ({
  processInvoicePaid: vi.fn(),
  processInvoiceTerminal: vi.fn(),
  loveAndPayTerminalReason: () => null,
}));

import { POST, resetWebhookAlertDedupForTests } from './route.ts';

function makeRequest(body: unknown): Request {
  return new Request('https://example.com/api/payments/loveandpay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/payments/loveandpay — секрет не задан', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWebhookAlertDedupForTests();
    h.env.LOVEANDPAY_WEBHOOK_SECRET = undefined;
  });

  it('РЕГРЕСС: событие не теряется молча — уходит Sentry-алёрт уровня error', async () => {
    const resp = await POST(makeRequest({ event: 'invoice.paid', data: { id: 'inv-1' } }));

    // Инвариант 6: статус всегда 200, иначе провайдер завалит очередь ретраями.
    expect(resp.status).toBe(200);
    expect(h.captureMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('LOVEANDPAY_WEBHOOK_SECRET'),
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('повторные запросы не жгут квоту Sentry (дедуп)', async () => {
    // Роут публичный и без rate-limit: без дедупа любой POST'ер выел бы квоту
    // событий, и настоящие платёжные алёрты Sentry начал бы отбрасывать.
    await POST(makeRequest({ event: 'invoice.paid' }));
    await POST(makeRequest({ event: 'invoice.paid' }));
    await POST(makeRequest({ event: 'invoice.paid' }));

    expect(h.captureMessageMock).toHaveBeenCalledTimes(1);
  });
});
