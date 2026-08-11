import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { z } from 'zod';

import { fetchJsonWithTimeout } from '../http.ts';
import { isNetworkTypeError } from '../loveandpay/client.ts';
import { isPaymentProviderUnavailable } from '../loveandpay/availability.ts';
import { LoveAndPayClient } from '../loveandpay/client.ts';
import { PaySpaceClient } from '../pay-space/client.ts';
import { createRemnawaveClient } from '../remnawave/client.ts';

/**
 * «`fetch` без timeout запрещён» (CLAUDE.md) — но таймаут обязан покрывать и
 * ЧТЕНИЕ ТЕЛА, а не только установление соединения.
 *
 * Находка аудита 2026-08-10: клиенты звали `clearTimeout` сразу после того, как
 * `fetch` вернул `Response`, и только потом читали `resp.text()`/`res.json()`.
 * Заголовки приходят рано, тело — потоком: сервер, который отдал `200 OK` и
 * замолчал на теле, подвешивал наш запрос НАВСЕГДА. Для `issue-card` это
 * означает зависший fulfillment уже после приёма рублей, для `payments/create` —
 * висящий self-call на всю `maxDuration` роута.
 *
 * Тесты держат ответ, чьё тело не приходит никогда, и проверяют, что запрос
 * обрывается по своему же таймауту. На старом коде каждый из них висел бы до
 * таймаута vitest.
 */

const silentLogger = pino({ level: 'silent' });

afterEach(() => {
  vi.useRealTimers();
});

/** Ответ, у которого пришли заголовки, а тело «висит» до отмены по сигналу. */
function hangingBodyResponse(signal: AbortSignal | null | undefined): Response {
  const never = <T>(): Promise<T> =>
    new Promise<T>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () => never<string>(),
    json: () => never<unknown>(),
  } as unknown as Response;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('таймаут покрывает чтение тела ответа', () => {
  it('PaySpace: подвисшее тело обрывается и уходит в ретрай', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) =>
        hangingBodyResponse(init.signal),
      )
      .mockImplementationOnce(async () =>
        jsonResponse(200, {
          success: true,
          data: { balance: '12.00', pending: '0.00', currency: 'USD' },
        }),
      );

    const client = new PaySpaceClient({
      apiKey: 'k',
      baseUrl: 'https://pay.test/api/v1',
      logger: silentLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: async () => {},
    });

    const promise = client.getVccBalance();
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(promise).resolves.toMatchObject({ balanceUsdCents: 1200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('Love&Pay: подвисшее тело на GET обрывается и уходит в ретрай', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) =>
        hangingBodyResponse(init.signal),
      )
      .mockImplementationOnce(async () =>
        jsonResponse(200, {
          success: true,
          invoice: {
            id: 'INV-1',
            invoiceNumber: 'INV-0001',
            amount: 100,
            currency: 'RUB',
            status: 'PENDING',
            paymentLink: 'https://lp/pay/INV-1',
            expiresAt: '2026-12-31T23:59:59Z',
          },
        }),
      );

    const client = new LoveAndPayClient({
      apiKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lp/api/v2',
      logger: silentLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const promise = client.getInvoice('INV-1');
    // Таймаут запроса (30 с) + backoff первого ретрая (500 мс).
    await vi.advanceTimersByTimeAsync(31_000);

    await expect(promise).resolves.toMatchObject({ id: 'INV-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('Remnawave: подвисшее тело обрывается таймаутом, а не висит вечно', async () => {
    // Ретраев у клиента панели нет намеренно — здесь важно только то, что
    // запрос завершается ошибкой, а не остаётся висеть.
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      hangingBodyResponse(init.signal),
    );

    const client = createRemnawaveClient({
      token: 't',
      baseUrl: 'https://panel.test',
      squadUuid: '00000000-0000-4000-8000-000000000000',
      trafficLimitBytes: 0,
      logger: silentLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 20,
    });

    // Именно AbortError, а не «ответ не JSON»: переклеенный ярлык объявил бы
    // дрейфом контракта нашу же отмену запроса (ревью 2026-08-11).
    await expect(client.findUserByTelegramId('379336096')).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('PaySpace: ретрай смотрит на HTTP-статус, а не только на конверт', () => {
  it('5xx с JSON без поля success ретраится у идемпотентной операции', async () => {
    // Балансировщик/WAF провайдера отдаёт свой JSON (`{"error":"upstream"}`),
    // в котором нашего `success` нет. До фикса это была мгновенная
    // PaySpaceContractError без единого повтора — при том что 503 у GET
    // ретраить безопасно и нужно (аудит 2026-08-10).
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse(503, { error: 'upstream unavailable' }))
      .mockImplementationOnce(async () =>
        jsonResponse(200, {
          success: true,
          data: { balance: '5.00', pending: '0.00', currency: 'USD' },
        }),
      );

    const client = new PaySpaceClient({
      apiKey: 'k',
      baseUrl: 'https://pay.test/api/v1',
      logger: silentLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: async () => {},
    });

    await expect(client.getVccBalance()).resolves.toMatchObject({ balanceUsdCents: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('createCard на таком же 5xx НЕ ретраится (дубль-карта дороже)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: 'upstream unavailable' }));

    const client = new PaySpaceClient({
      apiKey: 'k',
      baseUrl: 'https://pay.test/api/v1',
      logger: silentLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: async () => {},
    });

    await expect(client.createCard({ amountUsdCents: 1000 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchJsonWithTimeout: тело под тем же таймаутом', () => {
  it('подвисшее тело обрывается, а не висит вечно', async () => {
    // `fetchWithTimeout` отдаёт Response и снимает таймер — серверный код,
    // читающий тело после него, оставался без всякого срока (ревью 2026-08-11).
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) =>
        hangingBodyResponse(init?.signal),
      );
    try {
      await expect(
        fetchJsonWithTimeout('https://slow.test/x', {}, z.object({ ok: z.boolean() }), 20),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('классификатор сетевых ошибок undici', () => {
  it('обрыв сокета на теле («terminated») считается транспортным сбоем', () => {
    // undici бросает `fetch failed`, когда соединение не установилось, и
    // `terminated`, когда сокет умер уже после заголовков. Прежний предикат
    // `/fetch/i` второй случай не ловил — обрыв на теле не ретраился и не
    // показывал клиенту «технический сбой» (ревью 2026-08-11).
    expect(isNetworkTypeError(new TypeError('terminated'))).toBe(true);
    expect(isNetworkTypeError(new TypeError('fetch failed'))).toBe(true);
    expect(isPaymentProviderUnavailable(new TypeError('terminated'))).toBe(true);
    // Обычная ошибка типов транспортом не притворяется.
    expect(isNetworkTypeError(new TypeError('x.map is not a function'))).toBe(false);
  });
});
