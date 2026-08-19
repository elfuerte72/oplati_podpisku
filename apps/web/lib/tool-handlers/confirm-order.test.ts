import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `confirm_order` — денежный путь №1: именно он выставляет счёт. До аудита
 * 2026-08-10 у него не было ни одного теста, при том что на нём держатся три
 * барьера сразу: ownership заказа, гейт привязки Telegram (без неё клиент не
 * получит ни чек, ни реквизиты карты) и классификация отказов шлюза
 * (503/409/422 → разные тексты клиенту; generic-ошибка обещала бы оператора там,
 * где повторять бессмысленно).
 */

type OrderLike = { id: string; userId: string } | null;

const h = vi.hoisted(() => ({
  state: {
    order: null as OrderLike,
    telegramId: 12345 as number | null,
  },
  getOrderById: vi.fn(),
  getUserTelegramId: vi.fn(),
  captureMessage: vi.fn(),
  // env через мок модуля, а не process.env: иначе INTERNAL_API_TOKEN нельзя
  // погасить на один кейс и гейт «токен не задан» остаётся непокрытым.
  env: { INTERNAL_API_TOKEN: 'internal-token-value' as string | undefined } as Record<
    string,
    unknown
  >,
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  getOrderById: h.getOrderById,
  getUserTelegramId: h.getUserTelegramId,
}));

vi.mock('../env.server.ts', () => ({
  serverEnv: new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => h.env[key],
  }),
}));

vi.mock('../deployment-url.ts', () => ({
  selfCallBaseUrl: () => 'http://127.0.0.1:3000',
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: h.captureMessage,
  captureException: vi.fn(),
}));

import {
  confirmOrder,
  OrderAboveMaxAmountError,
  OrderExpiredError,
  PaymentCapacityError,
  PaymentProviderUnavailableError,
  TelegramLinkRequiredError,
} from './confirm-order.ts';

const OK_BODY = {
  ok: true,
  paymentUrl: 'https://pay.example.com/i/abc',
  qrPayload: 'qr-data',
  expiresAt: '2026-08-12T12:00:00.000Z',
};

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  h.state.order = { id: 'order-1', userId: 'user-1' };
  h.state.telegramId = 12345;
  h.getOrderById.mockReset().mockImplementation(async () => h.state.order);
  h.getUserTelegramId.mockReset().mockImplementation(async () => h.state.telegramId);
  h.captureMessage.mockClear();
  h.env.INTERNAL_API_TOKEN = 'internal-token-value';
  vi.unstubAllGlobals();
});

describe('confirmOrder — happy path', () => {
  it('возвращает ссылку оплаты и шлёт X-Internal-Token в self-call', async () => {
    const fetchMock = mockFetch(200, OK_BODY);

    const res = await confirmOrder({ orderId: 'order-1', userId: 'user-1' });

    expect(res).toEqual({
      paymentUrl: OK_BODY.paymentUrl,
      qrPayload: 'qr-data',
      expiresAt: OK_BODY.expiresAt,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3000/api/payments/create');
    expect((init.headers as Record<string, string>)['X-Internal-Token']).toBe(
      'internal-token-value',
    );
    expect(JSON.parse(init.body as string)).toEqual({ orderId: 'order-1' });
  });

  it('paymentMethod передаётся дальше только когда задан', async () => {
    const fetchMock = mockFetch(200, OK_BODY);
    await confirmOrder({ orderId: 'order-1', userId: 'user-1', paymentMethod: 'sbp' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ orderId: 'order-1', paymentMethod: 'sbp' });
  });

  it('qrPayload отсутствует в ответе → null, а не undefined', async () => {
    mockFetch(200, { ok: true, paymentUrl: OK_BODY.paymentUrl, expiresAt: OK_BODY.expiresAt });
    const res = await confirmOrder({ orderId: 'order-1', userId: 'user-1' });
    expect(res.qrPayload).toBeNull();
  });

  it('вызов из Telegram (без userId) не трогает БД и не требует привязки', async () => {
    // Кнопка прикреплена к сообщению владельца заказа — доверие установлено
    // самим Telegram'ом, ownership-проверка там не нужна и не выполняется.
    mockFetch(200, OK_BODY);
    await confirmOrder({ orderId: 'order-1' });
    expect(h.getOrderById).not.toHaveBeenCalled();
    expect(h.getUserTelegramId).not.toHaveBeenCalled();
  });
});

describe('confirmOrder — ownership', () => {
  it('чужой заказ не оплачивается и алёртится', async () => {
    h.state.order = { id: 'order-1', userId: 'someone-else' };
    const fetchMock = mockFetch(200, OK_BODY);

    await expect(confirmOrder({ orderId: 'order-1', userId: 'user-1' })).rejects.toThrow(
      /принадлежит другому пользователю/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.captureMessage).toHaveBeenCalledWith(
      'confirm_order: ownership mismatch',
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('несуществующий заказ отклоняется тем же путём', async () => {
    h.state.order = null;
    const fetchMock = mockFetch(200, OK_BODY);
    await expect(confirmOrder({ orderId: 'nope', userId: 'user-1' })).rejects.toThrow(
      /не найден или принадлежит другому/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('confirmOrder — гейт привязки Telegram', () => {
  it('веб-пользователь без telegram_id не получает счёт', async () => {
    // Чек и реквизиты карты доставляются ТОЛЬКО в Telegram: выставить счёт и
    // принять деньги, не имея канала доставки результата, нельзя.
    h.state.telegramId = null;
    const fetchMock = mockFetch(200, OK_BODY);

    await expect(confirmOrder({ orderId: 'order-1', userId: 'user-1' })).rejects.toBeInstanceOf(
      TelegramLinkRequiredError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('гейт проверяется ПОСЛЕ ownership — чужой заказ не подсказывает про привязку', async () => {
    h.state.order = { id: 'order-1', userId: 'someone-else' };
    h.state.telegramId = null;
    mockFetch(200, OK_BODY);
    // Позитивное утверждение: ровно отказ по ownership. Негативное
    // (`not.toBeInstanceOf`) удовлетворялось бы и падением на getOrderById,
    // то есть скрывало бы regression, при котором ломаются ОБЕ проверки.
    await expect(confirmOrder({ orderId: 'order-1', userId: 'user-1' })).rejects.toThrow(
      /принадлежит другому пользователю/,
    );
    // И привязку в этом случае вообще не спрашиваем — заказ уже чужой.
    expect(h.getUserTelegramId).not.toHaveBeenCalled();
  });
});

describe('confirmOrder — конфиг self-call', () => {
  it('незаданный INTERNAL_API_TOKEN не даёт уйти запросу без авторизации', async () => {
    h.env.INTERNAL_API_TOKEN = undefined;
    const fetchMock = mockFetch(200, OK_BODY);
    await expect(confirmOrder({ orderId: 'order-1' })).rejects.toThrow(/INTERNAL_API_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('confirmOrder — классификация отказов шлюза', () => {
  it('503 provider_unavailable → типизированная ошибка «попробуй позже»', async () => {
    mockFetch(503, { error: 'provider_unavailable' });
    await expect(confirmOrder({ orderId: 'order-1' })).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );
  });

  it('409 order_expired → «оформи заново», а не «сбой провайдера»', async () => {
    mockFetch(409, { error: 'order_expired' });
    await expect(confirmOrder({ orderId: 'order-1' })).rejects.toBeInstanceOf(OrderExpiredError);
  });

  it('422 above_max_amount несёт лимит из тела — клиенту называется цифра', async () => {
    mockFetch(422, { error: 'above_max_amount', maxAmountRub: 140000 });
    const err = await confirmOrder({ orderId: 'order-1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderAboveMaxAmountError);
    expect((err as OrderAboveMaxAmountError).maxAmountRub).toBe(140000);
  });

  it('422 без maxAmountRub в теле → лимит null, ошибка всё равно типизирована', async () => {
    mockFetch(422, { error: 'above_max_amount' });
    const err = await confirmOrder({ orderId: 'order-1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderAboveMaxAmountError);
    expect((err as OrderAboveMaxAmountError).maxAmountRub).toBeNull();
  });

  it('422 fulfillment_capacity несёт остаток фиксации цены — клиенту называется срок', async () => {
    // Карту выпустить нечем: счёт не выставлен, заказ жив. Клиенту говорим,
    // сколько ещё держится ЕГО цена, а не зашитые «два часа».
    mockFetch(422, { error: 'fulfillment_capacity', priceLockMinutesLeft: 43 });
    const err = await confirmOrder({ orderId: 'order-1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentCapacityError);
    expect((err as PaymentCapacityError).priceLockMinutesLeft).toBe(43);
  });

  it('422 fulfillment_capacity без срока в теле → null, ошибка всё равно типизирована', async () => {
    mockFetch(422, { error: 'fulfillment_capacity' });
    const err = await confirmOrder({ orderId: 'order-1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentCapacityError);
    expect((err as PaymentCapacityError).priceLockMinutesLeft).toBeNull();
  });

  it('код ошибки обязан совпасть со статусом: 503 с чужим кодом → generic', async () => {
    // Иначе любой 503 (в т.ч. от прокси/балансировщика) выдавался бы за
    // «шлюз временно недоступен» и звал повторить там, где повтор не поможет.
    mockFetch(503, { error: 'something_else' });
    const err = await confirmOrder({ orderId: 'order-1' }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PaymentProviderUnavailableError);
    expect((err as Error).message).toMatch(/вернул 503/);
  });

  it('не-JSON тело ошибки не роняет классификацию', async () => {
    mockFetch(500, '<html>502 Bad Gateway</html>');
    await expect(confirmOrder({ orderId: 'order-1' })).rejects.toThrow(/вернул 500/);
  });
});

describe('confirmOrder — контракт ответа', () => {
  it('невалидный JSON в 200 → явная ошибка, а не молчаливый undefined', async () => {
    mockFetch(200, 'не json');
    await expect(confirmOrder({ orderId: 'order-1' })).rejects.toThrow(/невалидный JSON/);
  });

  it('200 без paymentUrl → ошибка (иначе клиент получил бы пустую ссылку)', async () => {
    mockFetch(200, { ok: true, expiresAt: OK_BODY.expiresAt });
    await expect(confirmOrder({ orderId: 'order-1' })).rejects.toThrow(/неполный ответ/);
  });

  it('200 с ok:false → ошибка', async () => {
    mockFetch(200, { ...OK_BODY, ok: false });
    await expect(confirmOrder({ orderId: 'order-1' })).rejects.toThrow(/неполный ответ/);
  });

  it('200 без expiresAt → ошибка (нечего показать в «цена зафиксирована до»)', async () => {
    mockFetch(200, { ok: true, paymentUrl: OK_BODY.paymentUrl });
    await expect(confirmOrder({ orderId: 'order-1' })).rejects.toThrow(/неполный ответ/);
  });
});

describe('confirmOrder — self-call защищён таймаутом', () => {
  it('запрос уходит с AbortSignal (иначе висел бы дольше собственной функции)', async () => {
    const fetchMock = mockFetch(200, OK_BODY);
    await confirmOrder({ orderId: 'order-1' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('таймаут покрывает ЧТЕНИЕ ТЕЛА, а не только заголовки', async () => {
    // Правило CLAUDE.md: сервер, отдавший 200 и замолчавший на теле, вешал
    // запрос навсегда. Проверка `signal instanceof AbortSignal` этого не ловит —
    // перенос clearTimeout сразу после fetch() оставил бы её зелёной. Здесь
    // мы стоим ВНУТРИ чтения тела и смотрим, срабатывает ли abort.
    vi.useFakeTimers();
    let signalInsideBody: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      // Заголовки пришли, тело «молчит» — как у undici, обрыв приходит через
      // тот же signal, которым мы ограничили запрос.
      text: () =>
        new Promise<string>((resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signalInsideBody = signal;
          const timer = setTimeout(() => resolve(JSON.stringify(OK_BODY)), 60_000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('terminated'));
          });
        }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const settled = confirmOrder({ orderId: 'order-1' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(46_000);

    // Ключевая проверка: к 46-й секунде таймер ещё жив и оборвал чтение тела.
    expect(signalInsideBody?.aborted).toBe(true);
    await expect(settled).resolves.toBeInstanceOf(Error);
    vi.useRealTimers();
  });

  it('сетевой сбой self-call пробрасывается наверх (ссылка оплаты не выдумывается)', async () => {
    // Текущее поведение: AbortError/ECONNREFUSED идут сырой ошибкой, а НЕ
    // PaymentProviderUnavailableError, поэтому клиент видит generic-текст.
    // Тест фиксирует это явно; вопрос «маппить ли транспорт self-call'а в
    // provider_unavailable» вынесен в BACKLOG (ревью 2026-08-12).
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);
    const err = await confirmOrder({ orderId: 'order-1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(PaymentProviderUnavailableError);
  });
});
