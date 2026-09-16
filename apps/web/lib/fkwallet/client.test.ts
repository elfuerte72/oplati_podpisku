import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { FkWalletClient } from './client.ts';
import { FkWalletApiError, FkWalletContractError } from './errors.ts';

const PUBLIC_KEY = 'pub_1234567890';
const PRIVATE_KEY = 'priv_secret_key_value';

function makeClient(fetchImpl: typeof fetch, sink: unknown[] = []) {
  const logger = {
    debug: (o: unknown) => sink.push(o),
    info: (o: unknown) => sink.push(o),
    warn: (o: unknown) => sink.push(o),
    error: (o: unknown) => sink.push(o),
  } as unknown as ConstructorParameters<typeof FkWalletClient>[0]['logger'];
  return new FkWalletClient({
    publicKey: PUBLIC_KEY,
    privateKey: PRIVATE_KEY,
    baseUrl: 'https://api.fkwallet.io/v1/',
    logger,
    fetchImpl,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Клиент кошелька FKWallet — только чтение. Ключ у провайдера умеет двигать
 * деньги, поэтому главное, что здесь проверяется: ни ключ, ни адрес с ключом
 * не попадают в логи, а подпись собирается так, как описано в доке.
 */
describe('FkWalletClient.getBalance', () => {
  it('GET с подписью sha256 приватного ключа; публичный ключ в адресе; в логах ни того ни другого', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 'ok', data: [{ currency_code: 'RUB', value: '15000.00' }] }),
    );
    const logs: unknown[] = [];
    const client = makeClient(fetchMock as unknown as typeof fetch, logs);

    const rows = await client.getBalance({ timeoutMs: 3000 });

    expect(rows).toEqual([{ currency_code: 'RUB', value: '15000.00' }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.fkwallet.io/v1/${PUBLIC_KEY}/balance`);
    expect(init.method).toBe('GET');
    const expectedSign = createHash('sha256').update(PRIVATE_KEY).digest('hex');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${expectedSign}`);
    expect(init.body).toBeUndefined();

    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(PUBLIC_KEY);
    expect(logged).not.toContain(PRIVATE_KEY);
    expect(logged).not.toContain(expectedSign);
  });

  it('отказ провайдера (`status: error`) — FkWalletApiError с его текстом, даже при HTTP 200', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'error', message: 'Wrong sign' }));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await expect(client.getBalance()).rejects.toMatchObject({
      name: 'FkWalletApiError',
      message: 'Wrong sign',
      httpStatus: 200,
    });
  });

  it('HTTP 503 без тела-отказа — FkWalletApiError с кодом статуса', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ oops: true }, 503));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const err = await client.getBalance().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FkWalletApiError);
    expect((err as FkWalletApiError).httpStatus).toBe(503);
  });

  it('не JSON — контракт-дрейф, сырое тело не перечисляется', async () => {
    const fetchMock = vi.fn(async () => jsonResponse('<html>maintenance</html>'));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const err = await client.getBalance().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FkWalletContractError);
    expect((err as FkWalletContractError).rawBody).toBe('<html>maintenance</html>');
    expect(Object.keys(err as object)).not.toContain('rawBody');
  });

  it('ответ не той формы — контракт-дрейф, а не пустой баланс', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'ok', data: [{ nope: 1 }] }));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await expect(client.getBalance()).rejects.toBeInstanceOf(FkWalletContractError);
  });

  it('свой поводок обрывает зависший запрос', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await expect(client.getBalance({ timeoutMs: 20 })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
