import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  processMock: vi.fn(),
  clientIp: '168.119.157.136',
  // serverEnv кэшируется после первого обращения, поэтому подменяем сам модуль:
  // иначе тесты allowlist'а не смогли бы переключать значение между кейсами.
  env: {
    FREEKASSA_SECRET_WORD_2: 'secret-word-2' as string | undefined,
    FREEKASSA_SHOP_ID: 777 as number | undefined,
    FREEKASSA_ALLOWED_IPS: undefined as string | undefined,
  } as Record<string, unknown>,
}));

vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy({} as Record<string, unknown>, {
    get: (_target, key: string) => h.env[key],
  }),
}));

vi.mock('@/lib/freekassa/handlers', () => ({
  processFreekassaPaid: h.processMock,
}));

// getClientIp тянет env/timing-safe — подменяем источник IP отправителя.
vi.mock('@/lib/ratelimit', () => ({
  getClientIp: () => h.clientIp,
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { POST } from './route.ts';

const SECRET_2 = 'secret-word-2';

function sign(merchantId: string, amount: string, orderId: string): string {
  return createHash('md5').update(`${merchantId}:${amount}:${SECRET_2}:${orderId}`).digest('hex');
}

function makeRequest(
  params: Record<string, string>,
  init: { contentType?: string } = {},
): Request {
  return new Request('https://example.com/api/payments/freekassa', {
    method: 'POST',
    headers: {
      'Content-Type': init.contentType ?? 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
}

function validParams(overrides: Record<string, string> = {}): Record<string, string> {
  const merged = {
    MERCHANT_ID: '777',
    AMOUNT: '2490.50',
    intid: '999',
    MERCHANT_ORDER_ID: 'ORD-S3MGS-a1b2c3',
    ...overrides,
  };
  return {
    ...merged,
    SIGN: sign(merged.MERCHANT_ID, merged.AMOUNT, merged.MERCHANT_ORDER_ID),
    ...overrides,
  };
}

describe('POST /api/payments/freekassa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.clientIp = '168.119.157.136';
    h.env.FREEKASSA_SECRET_WORD_2 = 'secret-word-2';
    h.env.FREEKASSA_SHOP_ID = 777;
    h.env.FREEKASSA_ALLOWED_IPS = undefined;
    h.processMock.mockResolvedValue({ kind: 'processed', paymentId: 'pay-1', orderId: 'order-1' });
  });

  it('валидное уведомление обрабатывается и подтверждается телом YES', async () => {
    const resp = await POST(makeRequest(validParams()));

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('YES');
    expect(h.processMock).toHaveBeenCalledTimes(1);
  });

  it('невалидная подпись: 200 (инвариант 6), тело НЕ YES, обработчик не зван', async () => {
    const resp = await POST(makeRequest({ ...validParams(), SIGN: 'deadbeef' }));

    expect(resp.status).toBe(200);
    expect(await resp.text()).not.toBe('YES');
    expect(h.processMock).not.toHaveBeenCalled();
  });

  it('подделка суммы ломает подпись и отвергается', async () => {
    const params = validParams();
    const resp = await POST(makeRequest({ ...params, AMOUNT: '1.00' }));

    expect(await resp.text()).not.toBe('YES');
    expect(h.processMock).not.toHaveBeenCalled();
  });

  it('чужой MERCHANT_ID отвергается', async () => {
    const resp = await POST(makeRequest(validParams({ MERCHANT_ID: '888' })));

    expect(resp.status).toBe(200);
    expect(await resp.text()).not.toBe('YES');
    expect(h.processMock).not.toHaveBeenCalled();
  });

  it('битый payload не роняет endpoint', async () => {
    const resp = await POST(makeRequest({ intid: '999' }));

    expect(resp.status).toBe(200);
    expect(await resp.text()).not.toBe('YES');
  });

  it('платёж ещё не найден: НЕ подтверждаем — провайдер повторит', async () => {
    // Гонка «уведомление обогнало запись платежа» лечится повтором, поэтому
    // отвечать YES здесь нельзя: это навсегда потеряло бы оплату.
    h.processMock.mockResolvedValue({ kind: 'not_found', providerRef: '999' });

    const resp = await POST(makeRequest(validParams()));

    expect(resp.status).toBe(200);
    expect(await resp.text()).not.toBe('YES');
  });

  it('недоплата — исход окончательный: подтверждаем, чтобы не ретраили', async () => {
    h.processMock.mockResolvedValue({
      kind: 'amount_mismatch',
      paymentId: 'pay-1',
      expectedKopecks: 249_050,
      gotKopecks: 100_000,
    });

    expect(await (await POST(makeRequest(validParams()))).text()).toBe('YES');
  });

  it('повтор уведомления идемпотентен и тоже подтверждается', async () => {
    h.processMock.mockResolvedValue({
      kind: 'idempotent_skip',
      paymentId: 'pay-1',
      reason: 'already_processed',
    });

    expect(await (await POST(makeRequest(validParams()))).text()).toBe('YES');
  });

  it('сбой обработчика: 200 без YES (не роняем очередь, но и не подтверждаем)', async () => {
    h.processMock.mockRejectedValue(new Error('db down'));

    const resp = await POST(makeRequest(validParams()));

    expect(resp.status).toBe(200);
    expect(await resp.text()).not.toBe('YES');
  });

  it('IP вне списка при НЕзаданном FREEKASSA_ALLOWED_IPS только алёртит — деньги принимаются', async () => {
    // Провайдер может сменить адреса молча; жёсткий allowlist по умолчанию
    // положил бы приём денег без симптомов, кроме тишины.
    h.clientIp = '203.0.113.7';

    expect(await (await POST(makeRequest(validParams()))).text()).toBe('YES');
    expect(h.processMock).toHaveBeenCalledTimes(1);
  });

  it('IP вне списка при заданном FREEKASSA_ALLOWED_IPS отвергается', async () => {
    h.env.FREEKASSA_ALLOWED_IPS = '198.51.100.1, 198.51.100.2';
    h.clientIp = '203.0.113.7';

    const resp = await POST(makeRequest(validParams()));

    expect(await resp.text()).not.toBe('YES');
    expect(h.processMock).not.toHaveBeenCalled();
  });

  it('multipart/form-data разбирается наравне с urlencoded', async () => {
    const params = validParams();
    const fd = new FormData();
    for (const [k, v] of Object.entries(params)) fd.append(k, v);
    const req = new Request('https://example.com/api/payments/freekassa', {
      method: 'POST',
      body: fd,
    });

    expect(await (await POST(req)).text()).toBe('YES');
  });
});
