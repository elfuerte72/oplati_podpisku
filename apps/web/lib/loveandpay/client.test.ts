import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import { LoveAndPayClient } from './client.ts';
import { LoveAndPayApiError, LoveAndPayContractError } from './errors.ts';

const silentLogger = pino({ level: 'silent' });

function makeResp(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const INVOICE_OK_BODY = {
  success: true,
  invoice: {
    id: 'INV-1',
    invoiceNumber: 'INV-0001',
    amount: 100,
    currency: 'RUB',
    status: 'PENDING',
    qrCode: 'data:image/png;base64,xxx',
    qrPayload: 'sbp://...',
    paymentLink: 'https://loveandpay.io/pay/INV-1',
    expiresAt: '2026-12-31T23:59:59Z',
  },
};

describe('LoveAndPayClient.createInvoice', () => {
  it('успех на 2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp(200, INVOICE_OK_BODY));
    const c = new LoveAndPayClient({
      apiKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lp/api/v2',
      logger: silentLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const res = await c.createInvoice({
      amount: 100,
      currency: 'RUB',
      description: 'test',
      customer: {},
      expiresInHours: 24,
      kycRequired: false,
    });
    expect(res.invoice.id).toBe('INV-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ретрай при 429', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResp(429, { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'wait' } }))
      .mockResolvedValueOnce(makeResp(200, INVOICE_OK_BODY));
    const c = new LoveAndPayClient({
      apiKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lp/api/v2',
      logger: silentLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const res = await c.createInvoice({
      amount: 1,
      currency: 'RUB',
      description: 't',
      customer: {},
      expiresInHours: 24,
      kycRequired: false,
    });
    expect(res.invoice.id).toBe('INV-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('таймаут POST /invoices НЕ ретраится — второй счёт не создаётся (L-6)', async () => {
    const abortErr = new Error('This operation was aborted');
    abortErr.name = 'AbortError';
    const fetchMock = vi.fn().mockRejectedValue(abortErr);
    const c = new LoveAndPayClient({
      apiKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lp/api/v2',
      logger: silentLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(
      c.createInvoice({
        amount: 100,
        currency: 'RUB',
        description: 'test',
        customer: {},
        expiresInHours: 24,
        kycRequired: false,
      }),
    ).rejects.toThrow('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('таймаут GET (idempotent) ретраится как раньше', async () => {
    const abortErr = new Error('This operation was aborted');
    abortErr.name = 'AbortError';
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce(makeResp(200, INVOICE_OK_BODY));
    const c = new LoveAndPayClient({
      apiKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lp/api/v2',
      logger: silentLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const invoice = await c.getInvoice('INV-1');
    expect(invoice.id).toBe('INV-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('не ретраит 401', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResp(401, { success: false, error: { code: 'INVALID_SIGNATURE', message: 'bad' } }));
    const c = new LoveAndPayClient({
      apiKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lp/api/v2',
      logger: silentLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(
      c.createInvoice({
        amount: 1,
        currency: 'RUB',
        description: 't',
        customer: {},
        expiresInHours: 24,
        kycRequired: false,
      }),
    ).rejects.toBeInstanceOf(LoveAndPayApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('парсит плоский error-shape L&P в code/message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeResp(400, { error: 'NO_TERMINAL', hint: 'terminal not assigned', code: 'NO_TERMINAL' }),
      );
    const c = new LoveAndPayClient({
      apiKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lp/api/v2',
      logger: silentLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(
      c.createInvoice({
        amount: 1,
        currency: 'RUB',
        description: 't',
        customer: {},
        expiresInHours: 24,
        kycRequired: false,
      }),
    ).rejects.toMatchObject({ code: 'NO_TERMINAL', message: expect.stringContaining('terminal not assigned') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('бросает LoveAndPayContractError на невалидный JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp(200, 'not-json'));
    const c = new LoveAndPayClient({
      apiKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lp/api/v2',
      logger: silentLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(
      c.createInvoice({
        amount: 1,
        currency: 'RUB',
        description: 't',
        customer: {},
        expiresInHours: 24,
        kycRequired: false,
      }),
    ).rejects.toBeInstanceOf(LoveAndPayContractError);
  });
});
