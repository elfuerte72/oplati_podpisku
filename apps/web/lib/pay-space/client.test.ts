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

  it('H1: дрейф контракта не утекает полный PAN/CVV в pino-лог', async () => {
    // Дрейф card_no → cardNo (как уже в info/release): парс create падает, но
    // сырое тело содержит полный PAN+CVV. rawBody не должен попадать в логи.
    const driftBody = {
      success: true,
      data: {
        card: {
          card_id: 'c1',
          cardNo: '5395020388220113', // переименовано → schema.parse упадёт
          currency: 'USD',
          exp_date: '2027-01-20',
          cvv: '229',
          balance: '10.00',
          callback_url: null,
        },
        network: 'trc20',
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(makeResp(200, driftBody));
    const c = makeClient(fetchMock);
    const err = await c.createCard({ amountUsdCents: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaySpaceContractError);

    // rawBody доступен программно (для отладки), но НЕперечисляем → не сериализуется.
    expect((err as PaySpaceContractError).rawBody).toContain('5395020388220113');
    expect(Object.keys(err as object)).not.toContain('rawBody');
    expect(JSON.stringify(err)).not.toContain('5395020388220113');

    // Реальный вектор: issue-card делает `log.error({ err })`. Даже без redact
    // (первичная защита — неперечисляемость) PAN не должен попасть в вывод.
    const lines: string[] = [];
    const capture = pino({ level: 'error' }, { write: (s: string) => void lines.push(s) });
    capture.error({ event: 'job.issue_card.failed', err });
    expect(lines.join('')).not.toContain('5395020388220113');
  });
});

describe('PaySpaceClient.createCard — не-идемпотентность (H2)', () => {
  it('НЕ ретраит на сетевую ошибку — иначе повтор выпустит дубль-карту', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const c = makeClient(fetchMock);
    await expect(c.createCard({ amountUsdCents: 1000 })).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // ровно один POST /vcc/card/create/
  });

  it('НЕ ретраит на 5xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResp(503, { success: false, error: { code: 'busy', message: 'try later' } }));
    const c = makeClient(fetchMock);
    await expect(c.createCard({ amountUsdCents: 1000 })).rejects.toBeInstanceOf(PaySpaceApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('контраст: идемпотентный topup (с request_id) сетевую ошибку ретраит', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const c = makeClient(fetchMock);
    await expect(
      c.topupCard({ cardId: 'c1', amountUsdCents: 1000, requestId: 'r1' }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // повтор разрешён — request_id дедуплицирует
  });

  it('НЕ ретраит и 429 — одна попытка есть одна попытка', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResp(429, { success: false, error: { code: 'rate', message: 'slow' } }));
    const c = makeClient(fetchMock);
    await expect(c.createCard({ amountUsdCents: 1000 })).rejects.toBeInstanceOf(PaySpaceApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('PaySpaceClient — ретрай 429 у идемпотентных вызовов', () => {
  it('429 повторяется и доходит: запрос не обработан, повтор безопасен', async () => {
    // Без этого всплеск заказов ронял долив карты уже ПОСЛЕ приёма рублей.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResp(429, { success: false, error: { code: 'rate', message: 'slow down' } }),
      )
      .mockResolvedValueOnce(
        makeResp(200, { success: true, data: { request_id: 'r1', status: 'completed' } }),
      )
      .mockResolvedValueOnce(
        makeResp(200, {
          success: true,
          data: {
            card_id: 'c1',
            request_id: 'r1',
            bal_type: 'USD',
            total_amt: '20.00',
            recharge_amt: '10.00',
            op_time: 't',
          },
        }),
      );
    const c = makeClient(fetchMock);
    await expect(
      c.topupCard({ cardId: 'c1', amountUsdCents: 1000, requestId: 'r1' }),
    ).resolves.toBeDefined();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
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
    expect(res.topupCheckTotalUsdCents).toBe(6000);
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
    expect(res.topupCheckTotalUsdCents).toBe(5000);
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
    expect(res.topupCheckTotalUsdCents).toBeNull();
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
      cardType: 'MC',
      productCode: 'SG_SUB',
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

  /**
   * Дедлайн вызывающего. Дефолт клиента — 60 с на заголовки, 60 с на тело и
   * два захода: молчащий провайдер держит вызов до четырёх минут. Для выпуска
   * карты это правильная цена (рубли уже приняты), а для экрана панели —
   * страница, которую никто не дождётся.
   */
  it('свой дедлайн обрывает молчащий запрос и не уходит в ретрай', async () => {
    // Провайдер, который принял соединение и молчит: завершить вызов может
    // только abort по нашему таймеру. Если дедлайн не соблюдается, тест не
    // «покажет большое число», а зависнет и упадёт по таймауту vitest — это и
    // есть проверяемое поведение (замерять стенные часы внутри прогона незачем:
    // на нагруженном CI это источник необъяснимых падений).
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );
    const c = makeClient(fetchMock as unknown as ReturnType<typeof vi.fn>);

    await expect(c.getVccBalance({ timeoutMs: 40, attempts: 1 })).rejects.toThrow(/abort/i);

    // Ровно один заход: повтор удвоил бы ожидание вызывающего.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('дедлайн покрывает и ЧТЕНИЕ ТЕЛА, а не только заголовки', async () => {
    // Аудит 2026-08-10: сервер отдаёт 200 и замолкает на теле. Таймер на этой
    // фазе перевзводится — и обязан взводиться НАШИМ бюджетом, иначе экран
    // холдов ждал бы минуту вместо секунд, а тест первой фазы этого не видит.
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        Promise.resolve({
          status: 200,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
              });
            }),
        } as unknown as Response),
    );
    const c = makeClient(fetchMock as unknown as ReturnType<typeof vi.fn>);

    await expect(c.getVccBalance({ timeoutMs: 40, attempts: 1 })).rejects.toThrow(/abort/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('PaySpaceClient — гейт неидемпотентности сильнее просьбы вызывающего', () => {
  it('createCard не ретраится, даже если попросить больше заходов', async () => {
    // `createCard` — единственная мутирующая операция без идемпотентного ключа
    // у провайдера: повтор выпускает ВТОРУЮ профинансированную карту-призрак.
    // Инвариант держится в самом клиенте, а не в дисциплине вызывающих.
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const c = makeClient(fetchMock);

    await expect(
      (c as unknown as {
        request: (o: Record<string, unknown>) => Promise<unknown>;
      }).request({
        method: 'POST',
        path: '/vcc/card/create/',
        body: { amount: '10.00' },
        schema: { parse: (v: unknown) => v },
        idempotent: false,
        maxAttempts: 5,
      }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('испорченное число заходов не превращает вызов в мгновенный отказ', async () => {
    // `Math.max(1, NaN)` — это `NaN`, и цикл `attempt < NaN` не выполняется ни
    // разу: без нормализации метод бросал бы «retries exhausted», не сделав
    // НИ ОДНОГО запроса, — неотличимо от падения провайдера.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeResp(200, { success: true, data: { balance: '1.00', pending: '0.00', currency: 'USD' } }),
      );
    const c = makeClient(fetchMock);

    const res = await c.getVccBalance({ attempts: Number.NaN });

    expect(res.balanceUsdCents).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
