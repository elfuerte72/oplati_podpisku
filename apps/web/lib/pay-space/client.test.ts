import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { PaySpaceClient } from './client.ts';
import { PaySpaceApiError, PaySpaceContractError } from './errors.ts';

const silentLogger = pino({ level: 'silent' });

function makeResp(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(fetchMock: ReturnType<typeof vi.fn>, requestSecret?: string) {
  return new PaySpaceClient({
    apiKey: 'api_key_test',
    baseUrl: 'https://pay.test/api/v1',
    requestSecret,
    logger: silentLogger,
    fetchImpl: fetchMock as unknown as typeof fetch,
    sleepImpl: async () => {},
    topupPollAttempts: 3,
    topupPollDelayMs: 0,
  });
}

const CREATE_OK = {
  success: true,
  data: {
    card: {
      card_id: 'c1',
      card_no: '5395020388220113',
      currency: 'USD',
      exp_date: '2027-01-20',
      cvv: '229',
      balance: '10.00',
      callback_url: null,
    },
    network: 'trc20',
  },
};

describe('PaySpaceClient.createCard', () => {
  it('маппит ответ create в доменный результат (центы, маска, exp)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp(200, CREATE_OK));
    const c = makeClient(fetchMock);
    const res = await c.createCard({ amountUsdCents: 1000 });

    expect(res).toEqual({
      cardId: 'c1',
      pan: '5395020388220113',
      panMasked: '539502******0113',
      expMonth: 1,
      expYear: 2027,
      cvc: '229',
      balanceUsdCents: 1000,
      network: 'trc20',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://pay.test/api/v1/vcc/card/create/');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ amount: '10.00' }); // центы → доллары-строка
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer api_key_test');
  });

  it('парсит реальный ответ: balance числом + exp MM/YY (дрейф 2026-06-18)', async () => {
    const liveBody = {
      success: true,
      data: {
        card: {
          card_id: 'a27cdd4620260618130932',
          card_no: '5592680100101726',
          currency: 'USD',
          exp_date: '06/27',
          cvv: '167',
          balance: 1.0,
          callback_url: null,
        },
        network: 'trc20',
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(makeResp(200, liveBody));
    const c = makeClient(fetchMock);
    const res = await c.createCard({ amountUsdCents: 100 });
    expect(res.balanceUsdCents).toBe(100);
    expect(res.expMonth).toBe(6);
    expect(res.expYear).toBe(2027);
    expect(res.panMasked).toBe('559268******1726');
  });

  it('подписывает запрос при заданном requestSecret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp(200, CREATE_OK));
    const c = makeClient(fetchMock, 'req_secret');
    await c.createCard({ amountUsdCents: 1000 });
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Signature']).toBeTruthy();
    expect(headers['X-Timestamp']).toBeTruthy();
    expect(headers['X-Nonce']).toBeTruthy();
  });

  it('без requestSecret подпись не шлётся', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp(200, CREATE_OK));
    const c = makeClient(fetchMock);
    await c.createCard({ amountUsdCents: 1000 });
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Signature']).toBeUndefined();
  });

  it('success:false → PaySpaceApiError с кодом провайдера', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeResp(400, { success: false, error: { code: 'invalid_amount', message: 'bad' } }),
      );
    const c = makeClient(fetchMock);
    await expect(c.createCard({ amountUsdCents: 1 })).rejects.toMatchObject({
      name: 'PaySpaceApiError',
      code: 'invalid_amount',
    });
  });

  it('дрифт схемы (нет card) → PaySpaceContractError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp(200, { success: true, data: { network: 'trc20' } }));
    const c = makeClient(fetchMock);
    await expect(c.createCard({ amountUsdCents: 1000 })).rejects.toBeInstanceOf(PaySpaceContractError);
  });
});

describe('PaySpaceClient.topupCard', () => {
  it('completed: читает баланс из topup/check', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResp(200, { success: true, data: { request_id: 'r1', status: 'completed' } }))
      .mockResolvedValueOnce(
        makeResp(200, {
          success: true,
          data: {
            card_id: 'c1',
            request_id: 'r1',
            bal_type: 'USD',
            total_amt: '60.00',
            recharge_amt: '50.00',
            op_time: 't',
          },
        }),
      );
    const c = makeClient(fetchMock);
    const res = await c.topupCard({ cardId: 'c1', amountUsdCents: 5000, requestId: 'r1' });
    expect(res.status).toBe('completed');
    expect(res.balanceUsdCents).toBe(6000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('pending → поллит check, дожидается зачисления', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResp(200, { success: true, data: { request_id: 'r1', status: 'pending' } }))
      // первый check — ещё не зачислено (ошибка провайдера)
      .mockResolvedValueOnce(makeResp(400, { success: false, error: { code: 'pending', message: 'wait' } }))
      // второй check — зачислено
      .mockResolvedValueOnce(
        makeResp(200, {
          success: true,
          data: {
            card_id: 'c1',
            request_id: 'r1',
            bal_type: 'USD',
            total_amt: '50.00',
            recharge_amt: '50.00',
            op_time: 't',
          },
        }),
      );
    const c = makeClient(fetchMock);
    const res = await c.topupCard({ cardId: 'c1', amountUsdCents: 5000, requestId: 'r1' });
    expect(res.status).toBe('completed');
    expect(res.balanceUsdCents).toBe(5000);
  });

  it('status:failed → PaySpaceApiError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResp(200, { success: true, data: { request_id: 'r1', status: 'failed' } }));
    const c = makeClient(fetchMock);
    await expect(
      c.topupCard({ cardId: 'c1', amountUsdCents: 5000, requestId: 'r1' }),
    ).rejects.toBeInstanceOf(PaySpaceApiError);
  });

  it('остаётся pending, если check не подтвердил за все попытки', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResp(200, { success: true, data: { request_id: 'r1', status: 'pending' } }))
      .mockResolvedValue(makeResp(400, { success: false, error: { code: 'pending', message: 'wait' } }));
    const c = makeClient(fetchMock);
    const res = await c.topupCard({ cardId: 'c1', amountUsdCents: 5000, requestId: 'r1' });
    expect(res.status).toBe('pending');
    expect(res.balanceUsdCents).toBeNull();
  });
});

describe('PaySpaceClient.releaseCard / getVccBalance', () => {
  it('release → возвращённый остаток в центах', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResp(200, { success: true, data: { cardId: 'c1', releaseBal: '5.00' } }));
    const c = makeClient(fetchMock);
    const res = await c.releaseCard('c1', 'rel_1');
    expect(res).toEqual({ cardId: 'c1', releasedUsdCents: 500 });
  });

  it('getCardInfo: реальный ответ (cardBal строкой, card_email null)', async () => {
    const body = {
      success: true,
      data: {
        cardId: 'c1',
        cardNo: '5592680100101726',
        cvv: '167',
        expDate: '06/27',
        cardBal: '1.00',
        status: '1',
        usedAmt: '0.00',
        totalAmt: '1.00',
        settleAmt: '0.00',
        createTime: '2026-06-18 13:09:32',
        cardType: 'MC',
        productCode: 'SG_SUB',
        card_email: null,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(makeResp(200, body));
    const c = makeClient(fetchMock);
    const res = await c.getCardInfo('c1');
    expect(res).toEqual({
      cardId: 'c1',
      panMasked: '559268******1726',
      statusCode: '1',
      statusLabel: 'activated',
      balanceUsdCents: 100,
      expDate: '06/27',
    });
  });

  it('getVccBalance → центы', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeResp(200, { success: true, data: { balance: '1250.00', pending: '50.00', currency: 'USD' } }),
      );
    const c = makeClient(fetchMock);
    const res = await c.getVccBalance();
    expect(res).toEqual({ balanceUsdCents: 125000, pendingUsdCents: 5000, currency: 'USD' });
  });
});
