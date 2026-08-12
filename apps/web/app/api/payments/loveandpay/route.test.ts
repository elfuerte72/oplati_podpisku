import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Вебхук L&P: подпись — ЕДИНСТВЕННЫЙ барьер от поддельного `invoice.paid`.
 * Роут публичный, без rate-limit и без allowlist (входящий вебхук под
 * IP-allowlist провайдера не попадает), а успешная обработка переводит заказ в
 * `paid` и запускает выпуск карты за наши деньги. До аудита 2026-08-10 этот
 * барьер не был покрыт ни одним тестом.
 *
 * Второй инвариант здесь — «вебхук всегда 200» (инвариант 6 CLAUDE.md): любой
 * non-200 заставляет провайдера ретраить и забивает очередь.
 */

const SECRET = 'webhook-secret';

const h = vi.hoisted(() => ({
  paid: vi.fn(async (_args: unknown) => ({ kind: 'processed' })),
  terminal: vi.fn(async (_args: unknown) => ({ kind: 'processed' })),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  env: { LOVEANDPAY_WEBHOOK_SECRET: 'webhook-secret' as string | undefined } as Record<
    string,
    unknown
  >,
}));

vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => h.env[key],
  }),
}));

vi.mock('@/lib/loveandpay/handlers', () => ({
  processInvoicePaid: h.paid,
  processInvoiceTerminal: h.terminal,
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: h.captureMessage,
  captureException: h.captureException,
}));

import { POST, resetWebhookAlertDedupForTests } from './route.ts';

function sign(rawBody: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** Статус, который провайдер реально шлёт вместе с событием. */
const STATUS_FOR_EVENT: Record<string, string> = {
  'invoice.paid': 'PAID',
  'invoice.expired': 'EXPIRED',
  'invoice.cancelled': 'CANCELLED',
  'invoice.created': 'PENDING',
  INVOICE_PAID: 'PAID',
};

function event(name = 'invoice.paid', dataOverrides: Record<string, unknown> = {}) {
  return {
    event: name,
    data: {
      id: 'inv_123',
      invoiceNumber: 'ORD-S3MGS-a1b2c3',
      amountRub: 2490.5,
      currency: 'RUB',
      status: STATUS_FOR_EVENT[name] ?? 'PENDING',
      ...dataOverrides,
    },
  };
}

function paidEvent(overrides: Record<string, unknown> = {}) {
  return event('invoice.paid', overrides);
}

function makeRequest(body: unknown, signature?: string | null): Request {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const sig = signature === undefined ? sign(rawBody) : signature;
  if (sig !== null) headers['x-webhook-signature'] = sig;
  return new Request('https://example.com/api/payments/loveandpay', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

beforeEach(() => {
  h.paid.mockReset().mockResolvedValue({ kind: 'processed' });
  h.terminal.mockReset().mockResolvedValue({ kind: 'processed' });
  h.captureMessage.mockClear();
  h.captureException.mockClear();
  h.env.LOVEANDPAY_WEBHOOK_SECRET = SECRET;
  resetWebhookAlertDedupForTests();
});

describe('подпись — барьер от поддельной оплаты', () => {
  it('валидная подпись → событие обрабатывается', async () => {
    const res = await POST(makeRequest(paidEvent()));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, event: 'invoice.paid' });
    expect(h.paid).toHaveBeenCalledTimes(1);
  });

  it('чужая подпись → платёж НЕ кредитуется, алёрт уровня error', async () => {
    const body = paidEvent();
    const res = await POST(makeRequest(body, sign(JSON.stringify(body), 'wrong-secret')));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ skipped: 'invalid_signature' });
    expect(h.paid).not.toHaveBeenCalled();
    expect(h.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('невалидная подпись'),
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('подпись без заголовка → 200 + алёрт (инвариант 6 распространяется и сюда)', async () => {
    // Ответ не-200 здесь заставил бы L&P ретраить один и тот же неподписанный
    // запрос бесконечно.
    const res = await POST(makeRequest(paidEvent(), null));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ skipped: 'missing_signature' });
    expect(h.paid).not.toHaveBeenCalled();
    expect(h.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('без X-Webhook-Signature'),
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('мусорная подпись другой длины → 200, а не падение timingSafeEqual', async () => {
    // `verifyWebhookSignature` зовётся ВНЕ try/catch роута: если исчезнет
    // guard по длине, `timingSafeEqual` бросит, роут ответит 500 и провайдер
    // начнёт ретраить бесконечно — ровно то, от чего защищает инвариант 6.
    for (const bad of ['abc', '', 'sha256=zz', 'sha256=' + 'f'.repeat(63)]) {
      const res = await POST(makeRequest(paidEvent(), bad));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        skipped: bad === '' ? 'missing_signature' : 'invalid_signature',
      });
    }
    expect(h.paid).not.toHaveBeenCalled();
  });

  it('подпись считается по СЫРОМУ телу: та же структура с другим порядком ключей не проходит', async () => {
    // Ловушка контракта: `JSON.parse → JSON.stringify` (или `await req.json()`
    // с последующей пересериализацией) даёт семантически ТОТ ЖЕ объект, но
    // другие байты. Подпись обязана считаться по исходным байтам, иначе каждый
    // реальный вебхук L&P начнёт отваливаться на проверке.
    const original = JSON.stringify(paidEvent());
    const parsed = JSON.parse(original) as Record<string, unknown>;
    const reordered = JSON.stringify({ data: parsed.data, event: parsed.event });
    // Байты разные, а разобранный объект — тот же.
    expect(reordered).not.toBe(original);
    expect(JSON.parse(reordered)).toEqual(parsed);

    const req = new Request('https://example.com/api/payments/loveandpay', {
      method: 'POST',
      headers: { 'x-webhook-signature': sign(original) },
      body: reordered,
    });
    await expect((await POST(req)).json()).resolves.toMatchObject({
      skipped: 'invalid_signature',
    });
    expect(h.paid).not.toHaveBeenCalled();
  });

  it('подпись принимается и без префикса sha256=', async () => {
    const body = JSON.stringify(paidEvent());
    const bare = createHmac('sha256', SECRET).update(body).digest('hex');
    const res = await POST(makeRequest(paidEvent(), bare));
    await expect(res.json()).resolves.toMatchObject({ event: 'invoice.paid' });
  });
});

describe('секрет не задан — потеря платёжного события не должна быть тихой', () => {
  it('отвечает 200, но алёртит уровнем error', async () => {
    h.env.LOVEANDPAY_WEBHOOK_SECRET = undefined;
    const res = await POST(makeRequest(paidEvent()));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ skipped: 'not_configured' });
    expect(h.paid).not.toHaveBeenCalled();
    expect(h.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('LOVEANDPAY_WEBHOOK_SECRET не задан'),
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('алёрт дедуплицируется — публичный роут не выедает квоту Sentry', async () => {
    h.env.LOVEANDPAY_WEBHOOK_SECRET = undefined;
    await POST(makeRequest(paidEvent()));
    await POST(makeRequest(paidEvent()));
    await POST(makeRequest(paidEvent()));
    expect(h.captureMessage).toHaveBeenCalledTimes(1);
  });
});

describe('инвариант 6 — ответ всегда 200', () => {
  it('битый JSON под валидной подписью → 200 skipped', async () => {
    const res = await POST(makeRequest('не json'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ skipped: 'invalid_json' });
  });

  it('тело не по контракту → 200 skipped, обработчик не зван', async () => {
    const res = await POST(makeRequest({ event: 'invoice.paid', data: {} }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ skipped: 'invalid_payload' });
    expect(h.paid).not.toHaveBeenCalled();
  });

  it('обработчик бросил → 200 + Sentry (иначе L&P ретраит бесконечно)', async () => {
    h.paid.mockRejectedValueOnce(new Error('БД лежит'));
    const res = await POST(makeRequest(paidEvent()));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ skipped: 'handler_error' });
    expect(h.captureException).toHaveBeenCalled();
  });
});

describe('маршрутизация событий', () => {
  it('invoice.expired → терминальный путь с reason=expired', async () => {
    await POST(makeRequest(event('invoice.expired')));
    expect(h.terminal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'expired' }));
    expect(h.paid).not.toHaveBeenCalled();
  });

  it('invoice.cancelled → reason=cancelled', async () => {
    await POST(makeRequest(event('invoice.cancelled')));
    expect(h.terminal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'cancelled' }));
  });

  it('invoice.created игнорируется — деньги ещё не пришли', async () => {
    const res = await POST(makeRequest(event('invoice.created')));
    await expect(res.json()).resolves.toMatchObject({ skipped: 'created_ignored' });
    expect(h.paid).not.toHaveBeenCalled();
    expect(h.terminal).not.toHaveBeenCalled();
  });

  it('UPPER_SNAKE от тестовой панели кабинета алиасится в канонический event', async () => {
    await POST(makeRequest(event('INVOICE_PAID')));
    expect(h.paid).toHaveBeenCalledTimes(1);
  });
});

/**
 * Обработчик обязан получать РАЗОБРАННЫЙ схемой объект, а не сырое тело: схема
 * нормализует `invoiceId → id` (формат тестовой панели) и считает
 * `amountKopecks` из `amountRub`. Без этого `provider_ref` пустеет (идемпотентность
 * `UNIQUE(provider, provider_ref)` схлопывается), а гейт недоплаты сравнивает
 * рубли с копейками и хоронит оплаченный заказ в `failed` (находка ревью).
 */
describe('в обработчик уходит нормализованный Zod-выход', () => {
  it('amountRub нормализуется в amountKopecks', async () => {
    await POST(makeRequest(paidEvent()));
    expect(h.paid).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ id: 'inv_123', amountKopecks: 249050 }),
      }),
    );
  });

  it('invoiceId легаси-формата приезжает как id', async () => {
    const legacy = {
      event: 'invoice.paid',
      data: { invoiceId: 'inv_777', invoiceNumber: 'ORD-X', amountRub: 100, status: 'PAID' },
    };
    await POST(makeRequest(legacy));
    expect(h.paid).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ id: 'inv_777' }) }),
    );
  });

  it('rawPayload передаётся для аудит-следа платежа', async () => {
    await POST(makeRequest(paidEvent()));
    const arg = h.paid.mock.calls[0]?.[0] as { rawPayload: unknown };
    expect(arg.rawPayload).toBeTruthy();
  });

  it('терминальный путь тоже получает разобранные данные', async () => {
    await POST(makeRequest(event('invoice.expired')));
    expect(h.terminal).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ id: 'inv_123' }) }),
    );
  });
});
