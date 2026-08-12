import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/orders/confirm` — неаутентифицированный write-эндпоинт, подтверждающий
 * заказ из веб-чата. Инвариант 9 CLAUDE.md требует, чтобы rate-limit по IP
 * стоял ДО резолва сессии и записи в БД: без cookie каждый запрос иначе
 * получает свежую сессию, свежую строку `users` и свежий суточный кап заказов
 * (cost-DoS). Порядок вызовов до аудита 2026-08-10 не был зафиксирован тестом,
 * то есть перестановка двух строк проходила бы CI незамеченной.
 *
 * Второе, что здесь проверяется, — отображение типизированных отказов
 * `confirm_order` в HTTP-коды: по ним UI решает, показать кнопку привязки,
 * позвать оформить заказ заново или предложить повтор.
 */

const h = vi.hoisted(() => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getOrCreateWebSessionId: vi.fn(async () => 'web-session-1'),
  getOrCreateUser: vi.fn(async () => ({ id: 'user-1' })),
  confirmOrder: vi.fn(),
  captureException: vi.fn(),
  errors: {} as Record<string, unknown>,
}));

vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: h.checkRateLimit,
  getClientIp: () => '203.0.113.7',
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  getOrCreateUserByWebSessionId: h.getOrCreateUser,
}));

vi.mock('@/lib/chat/session', () => ({
  getOrCreateWebSessionId: h.getOrCreateWebSessionId,
}));

vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException, captureMessage: vi.fn() }));

// Классы ошибок берём настоящие (instanceof в роуте), подменяем только вызов.
vi.mock('@/lib/tool-handlers/confirm-order', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tool-handlers/confirm-order')>();
  return { ...actual, confirmOrder: h.confirmOrder };
});

import {
  OrderAboveMaxAmountError,
  OrderExpiredError,
  PaymentProviderUnavailableError,
  TelegramLinkRequiredError,
} from '@/lib/tool-handlers/confirm-order';

import { POST } from './route.ts';

const ORDER_ID = '11111111-2222-4333-8444-555555555555';

function makeRequest(body: unknown = { orderId: ORDER_ID }): Request {
  return new Request('https://example.com/api/orders/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  h.checkRateLimit.mockReset().mockResolvedValue({ allowed: true });
  h.getOrCreateWebSessionId.mockReset().mockResolvedValue('web-session-1');
  h.getOrCreateUser.mockReset().mockResolvedValue({ id: 'user-1' });
  h.confirmOrder.mockReset().mockResolvedValue({
    paymentUrl: 'https://pay/1',
    qrPayload: null,
    expiresAt: '2026-08-12T12:00:00.000Z',
  });
  h.captureException.mockClear();
});

describe('инвариант 9 — rate-limit до резолва сессии', () => {
  it('превышение лимита → 429 БЕЗ создания сессии и строки users', async () => {
    h.checkRateLimit.mockResolvedValueOnce({ allowed: false });
    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    expect(h.getOrCreateWebSessionId).not.toHaveBeenCalled();
    expect(h.getOrCreateUser).not.toHaveBeenCalled();
    expect(h.confirmOrder).not.toHaveBeenCalled();
  });

  it('лимит проверяется РАНЬШЕ разбора тела — битый JSON тоже расходует бакет', async () => {
    // Иначе поток мусорных тел обходил бы лимит целиком.
    h.checkRateLimit.mockResolvedValueOnce({ allowed: false });
    const res = await POST(makeRequest('{ битый'));
    expect(res.status).toBe(429);
  });

  it('порядок вызовов: checkRateLimit строго перед getOrCreateUser', async () => {
    await POST(makeRequest());
    expect(h.checkRateLimit.mock.invocationCallOrder[0]!).toBeLessThan(
      h.getOrCreateUser.mock.invocationCallOrder[0]!,
    );
  });

  it('лимит берётся по IP клиента и в СВОЁМ бакете', async () => {
    await POST(makeRequest());
    expect(h.checkRateLimit).toHaveBeenCalledWith('web-order', '203.0.113.7');
  });
});

describe('валидация тела', () => {
  it('битый JSON → 400', async () => {
    const res = await POST(makeRequest('{ битый'));
    expect(res.status).toBe(400);
    expect(h.confirmOrder).not.toHaveBeenCalled();
  });

  it('orderId не UUID → 400 (не доходит до денежного пути)', async () => {
    const res = await POST(makeRequest({ orderId: 'ORD-AB12' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_body' });
    expect(h.confirmOrder).not.toHaveBeenCalled();
  });
});

describe('ownership делегируется confirmOrder вместе с userId', () => {
  it('userId сессии передаётся — чужой orderId отсекает confirm_order', async () => {
    await POST(makeRequest());
    expect(h.confirmOrder).toHaveBeenCalledWith({ orderId: ORDER_ID, userId: 'user-1' });
  });

  it('успех отдаёт ссылку оплаты', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, paymentUrl: 'https://pay/1' });
  });

  it('сбой резолва сессии → 503, а не 500 и не тихий успех', async () => {
    h.getOrCreateUser.mockRejectedValueOnce(new Error('БД лежит'));
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    expect(h.confirmOrder).not.toHaveBeenCalled();
  });
});

describe('типизированные отказы → HTTP-коды, по которым UI выбирает действие', () => {
  it('нет привязки Telegram → 409 telegram_link_required', async () => {
    h.confirmOrder.mockRejectedValueOnce(new TelegramLinkRequiredError());
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'telegram_link_required' });
  });

  it('протухшая фиксация цены → 409 order_expired', async () => {
    h.confirmOrder.mockRejectedValueOnce(new OrderExpiredError());
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'order_expired' });
  });

  it('выше лимита шлюза → 422 с конкретной цифрой в тексте', async () => {
    h.confirmOrder.mockRejectedValueOnce(new OrderAboveMaxAmountError(140000));
    const res = await POST(makeRequest());
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; text: string };
    expect(body.error).toBe('above_max_amount');
    expect(body.text).toContain('140');
  });

  it('транспорт до шлюза лежит → 503 provider_unavailable', async () => {
    h.confirmOrder.mockRejectedValueOnce(new PaymentProviderUnavailableError());
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: 'provider_unavailable' });
  });

  it('неожиданная ошибка → 500 + Sentry, текст без внутренних деталей', async () => {
    h.confirmOrder.mockRejectedValueOnce(new Error('secret internal detail'));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { text: string };
    expect(body.text).not.toContain('secret internal detail');
    expect(h.captureException).toHaveBeenCalled();
  });

  it('ожидаемые отказы НЕ шумят в Sentry', async () => {
    h.confirmOrder.mockRejectedValueOnce(new TelegramLinkRequiredError());
    await POST(makeRequest());
    expect(h.captureException).not.toHaveBeenCalled();
  });
});
