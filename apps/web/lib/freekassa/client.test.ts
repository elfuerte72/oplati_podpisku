import { describe, expect, it, vi } from 'vitest';

import { signApiRequest } from './sign.ts';
import { FreekassaClient } from './client.ts';
import { FreekassaApiError, FreekassaContractError } from './errors.ts';

const API_KEY = 'test-api-key';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Parameters<typeof makeClient>[0]['logger'];

function makeClient(opts: {
  fetchImpl: typeof fetch;
  nonceProvider?: () => Promise<number>;
  logger?: unknown;
}) {
  return new FreekassaClient({
    apiKey: API_KEY,
    shopId: 777,
    baseUrl: 'https://api.fk.life/v1',
    logger: (opts.logger ?? silentLogger) as never,
    nonceProvider: opts.nonceProvider ?? (async () => 2_000_000_001),
    fetchImpl: opts.fetchImpl,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SUCCESS_BODY = {
  type: 'success',
  orderId: 123,
  orderHash: 'bd4161db429848651499aabcb1d89330',
  location: 'https://pay.freekassa.ru/form/123/bd4161db429848651499aabcb1d89330',
};

const INPUT = {
  paymentId: 'ORD-S3MGS-a1b2c3',
  amountKopecks: 249_050,
  email: '12345@telegram.org',
  ip: '177.7.34.106',
  methodId: 44,
};

describe('FreekassaClient.createOrder', () => {
  it('шлёт подписанное тело с shopId, nonce и суммой в РУБЛЯХ', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SUCCESS_BODY));
    const client = makeClient({ fetchImpl: fetchMock as unknown as typeof fetch });

    const resp = await client.createOrder(INPUT);

    expect(resp.orderId).toBe('123');
    expect(resp.location).toBe(SUCCESS_BODY.location);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.fk.life/v1/orders/create');
    expect(init.method).toBe('POST');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      shopId: 777,
      nonce: 2_000_000_001,
      paymentId: 'ORD-S3MGS-a1b2c3',
      i: 44,
      email: '12345@telegram.org',
      ip: '177.7.34.106',
      amount: 2490.5,
      currency: 'RUB',
    });
  });

  it('подпись считается по телу БЕЗ самого поля signature', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SUCCESS_BODY));
    const client = makeClient({ fetchImpl: fetchMock as unknown as typeof fetch });
    await client.createOrder(INPUT);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const { signature, ...params } = JSON.parse(String(init.body)) as Record<string, string | number>;
    expect(signature).toBe(signApiRequest(params, API_KEY));
  });

  it('берёт свежий nonce на каждый вызов', async () => {
    let counter = 2_000_000_000;
    const fetchMock = vi.fn(async () => jsonResponse(SUCCESS_BODY));
    const client = makeClient({
      fetchImpl: fetchMock as unknown as typeof fetch,
      nonceProvider: async () => ++counter,
    });

    await client.createOrder(INPUT);
    await client.createOrder(INPUT);

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const nonces = calls.map(
      ([, init]) => (JSON.parse(String(init.body)) as { nonce: number }).nonce,
    );
    expect(nonces).toEqual([2_000_000_001, 2_000_000_002]);
    // Монотонность — требование провайдера («всегда больше предыдущего»).
    expect(nonces[1]).toBeGreaterThan(nonces[0] as number);
  });

  it('НЕ ретраит: создание заказа не идемпотентно, повтор создал бы второй счёт', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ type: 'error', message: 'oops' }, 500));
    const client = makeClient({ fetchImpl: fetchMock as unknown as typeof fetch });

    await expect(client.createOrder(INPUT)).rejects.toBeInstanceOf(FreekassaApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('распознаёт отказ по полю type=error даже при HTTP 200', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ type: 'error', message: 'Bad signature' }));
    const client = makeClient({ fetchImpl: fetchMock as unknown as typeof fetch });

    await expect(client.createOrder(INPUT)).rejects.toMatchObject({
      name: 'FreekassaApiError',
      message: 'Bad signature',
    });
  });

  it('дрейф контракта — FreekassaContractError, а не «успех»', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ type: 'success', orderId: 1 }));
    const client = makeClient({ fetchImpl: fetchMock as unknown as typeof fetch });

    await expect(client.createOrder(INPUT)).rejects.toBeInstanceOf(FreekassaContractError);
  });

  it('не-JSON тело — тоже контракт-ошибка, а не падение парсера', async () => {
    const fetchMock = vi.fn(
      async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );
    const client = makeClient({ fetchImpl: fetchMock as unknown as typeof fetch });

    await expect(client.createOrder(INPUT)).rejects.toBeInstanceOf(FreekassaContractError);
  });

  it('передаёт AbortSignal (fetch без таймаута запрещён конвенцией)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SUCCESS_BODY));
    const client = makeClient({ fetchImpl: fetchMock as unknown as typeof fetch });
    await client.createOrder(INPUT);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('валидирует исходящие данные до вызова провайдера', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SUCCESS_BODY));
    const client = makeClient({ fetchImpl: fetchMock as unknown as typeof fetch });

    await expect(client.createOrder({ ...INPUT, email: 'не-почта' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
