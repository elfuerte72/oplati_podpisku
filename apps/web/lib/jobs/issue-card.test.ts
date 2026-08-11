import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv (logger и пр.).
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
// Буфер карты на VAT/FX фиксируем явно (serverEnv кэшируется на весь файл):
// цена $20.00 → карта ceil(2000 × 1.20) = 2400 центов.
process.env.PAYSPACE_CARD_BUFFER_PERCENT = '20';
// Прямой ops-алерт в Telegram при провале выпуска (notifyOps).
process.env.ALERT_TELEGRAM_CHAT_ID = '111222333';

type OrderLike = {
  id: string;
  userId: string;
  status: string;
  originalAmount: number | null;
  shortId: string;
  serviceId: string | null;
};

const h = vi.hoisted(() => {
  // Стаб PaySpaceApiError: issue-card делает `err instanceof PaySpaceApiError`,
  // поэтому брошенная в тесте ошибка должна быть инстансом ИМЕННО того класса,
  // что экспортит мок '../pay-space/index.ts' ниже.
  class PaySpaceApiError extends Error {
    code: string;
    httpStatus: number;
    constructor(opts: { code: string; message: string; httpStatus?: number }) {
      super(opts.message);
      this.name = 'PaySpaceApiError';
      this.code = opts.code;
      // 400 по умолчанию: доменный отказ провайдера. Транспортные сбои (429/5xx)
      // тесты задают явно — от статуса зависит, идлить карту или нет.
      this.httpStatus = opts.httpStatus ?? 400;
    }
  }
  return {
    topupMock: vi.fn(),
    createCardMock: vi.fn(),
    getCardInfoMock: vi.fn(),
    sendMessageMock: vi.fn(),
    PaySpaceApiError,
    paySpaceConfigured: { value: true },
    dbState: {
      order: null as OrderLike | null,
      claimTransitioned: true,
      activeCard: null as Record<string, unknown> | null,
      serviceSlug: 'chatgpt-plus' as string | null,
    },
  };
});

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  getOrderById: vi.fn(async () => h.dbState.order),
  transitionOrderDetailed: vi.fn(async (_db: unknown, input: { toStatus: string }) => ({
    order: { ...(h.dbState.order ?? {}), status: input.toStatus },
    transitioned: h.dbState.claimTransitioned,
  })),
  transitionOrder: vi.fn(async () => ({})),
  findActiveByUserId: vi.fn(async () => h.dbState.activeCard),
  createCard: vi.fn(async () => ({ id: 'card-new', providerCardId: 'pc-new', panMasked: '****1234' })),
  markIdle: vi.fn(async () => {}),
  updateBalance: vi.fn(async () => {}),
  setOrderCardId: vi.fn(async () => {}),
  appendOrderEvent: vi.fn(async () => {}),
  getUserTelegramId: vi.fn(async () => '12345'),
  getServiceById: vi.fn(async () =>
    h.dbState.serviceSlug ? { slug: h.dbState.serviceSlug } : null,
  ),
}));

vi.mock('../pay-space/index.ts', () => ({
  isPaySpaceConfigured: () => h.paySpaceConfigured.value,
  getPaySpaceClient: () => ({
    topupCard: h.topupMock,
    createCard: h.createCardMock,
    getCardInfo: h.getCardInfoMock,
  }),
  PaySpaceApiError: h.PaySpaceApiError,
}));

vi.mock('../billing-address.ts', () => ({
  getRandomUsBillingAddress: vi.fn(async () => ({
    streetLine1: '350 5th Ave',
    city: 'New York',
    state: 'New York',
    stateCode: 'NY',
    postalCode: '10118',
    country: 'United States',
    countryCode: 'US',
  })),
  formatBillingAddressLines: vi.fn((address: { streetLine1: string; city: string; postalCode: string }) => [
    `Street address: ${address.streetLine1}`,
    `City: ${address.city}`,
    'State: New York (NY)',
    `ZIP: ${address.postalCode}`,
    'Country: United States',
  ]),
}));

vi.mock('../telegram/bot.ts', () => ({
  getBot: () => ({ api: { sendMessage: h.sendMessageMock } }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as db from '@oplati/db';
import { issueCard } from './issue-card.ts';

const baseOrder: OrderLike = {
  id: 'order-1',
  userId: 'user-1',
  status: 'paid',
  originalAmount: 2000, // $20.00
  shortId: 'ORD-AAAAA',
  serviceId: 'service-1',
};

const activeCard = {
  id: 'card-1',
  userId: 'user-1',
  provider: 'paypace',
  providerCardId: 'pc-1',
  panMasked: '****1111',
  status: 'active',
  balanceUsdCents: 0,
  lastUsedAt: null,
  recycledAt: null,
  createdAt: new Date(),
};

describe('issueCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.paySpaceConfigured.value = true;
    h.dbState.order = { ...baseOrder };
    h.dbState.claimTransitioned = true;
    h.dbState.activeCard = { ...activeCard };
    h.dbState.serviceSlug = 'chatgpt-plus';
    h.topupMock.mockResolvedValue({
      cardId: 'pc-1',
      requestId: 'topup_order-1_card-1',
      status: 'completed',
      balanceUsdCents: 2000,
    });
    h.getCardInfoMock.mockResolvedValue({
      cardId: 'pc-new',
      panMasked: '411111******1234',
      statusCode: '1',
      statusLabel: 'activated',
      balanceUsdCents: 2400,
      expDate: '12/30',
      cardType: 'MC',
      productCode: 'SG_SUB',
    });
  });

  it('happy path: claim успешен, активная карта → топ-ап на сумму С БУФЕРОМ', async () => {
    await issueCard('order-1');

    expect(db.transitionOrderDetailed).toHaveBeenCalledTimes(1);
    expect(h.topupMock).toHaveBeenCalledTimes(1);
    // Цена $20.00 (2000), буфер 20% → карта на 2400 (запас под VAT/FX).
    expect(h.topupMock).toHaveBeenCalledWith({
      cardId: 'pc-1',
      amountUsdCents: 2400,
      // Короткий детерминированный ключ (длинный PaySpace молча отклоняет).
      requestId: expect.stringMatching(/^t_[0-9a-f]{16}$/),
    });
    // updateBalance пишет фактически пополненную (буферизованную) сумму.
    expect(db.updateBalance).toHaveBeenCalledTimes(1);
    expect(db.updateBalance).toHaveBeenCalledWith(expect.anything(), 'card-1', 2400, expect.anything());
    // in_fulfillment → completed (claim уже сделал paid → in_fulfillment).
    expect(db.transitionOrder).toHaveBeenCalledTimes(1);
    // Повторная оплата: клиент получает уведомление о пополнении с ценой ($20 =
    // original 2000, БЕЗ буфера) и кнопкой-инструкцией. Реквизиты НЕ шлём.
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining('Карта пополнена'),
      expect.objectContaining({ parse_mode: 'HTML', reply_markup: expect.anything() }),
    );
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.any(String),
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            [
              expect.objectContaining({
                text: 'Открыть прайс сервиса',
                url: 'https://openai.com/chatgpt/pricing/',
              }),
            ],
          ]),
        }),
      }),
    );
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining('$20'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining('не в мобильном приложении'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });

  it('ошибка lookup прайса не блокирует fulfillment и оставляет кнопку инструкции', async () => {
    vi.mocked(db.getServiceById).mockRejectedValueOnce(new Error('db down'));

    await issueCard('order-1');

    expect(h.topupMock).toHaveBeenCalledTimes(1);
    expect(db.transitionOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'completed' }),
    );
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.any(String),
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: [
            [expect.objectContaining({ text: '📖 Как оплатить — пошагово' })],
          ],
        }),
      }),
    );
  });

  it('topup завис в pending → failed, но с событием topup_pending и requestId в алёрте', async () => {
    // История правки: сначала заказ оставляли в `in_fulfillment`, чтобы не врать
    // терминальным `failed`. Ревью показало, что выхода из этого статуса нет ни
    // одним путём кода, а `findStuckInFulfillmentOrders` алёртит каждые 5 минут
    // бессрочно. Вечная парковка плюс шум хуже огрублённого статуса, поэтому
    // заказ уходит в `failed`, а `requestId`/`cardId` сохраняются событием.
    h.topupMock.mockResolvedValue({
      cardId: 'pc-1',
      requestId: 'topup_order-1_card-1',
      status: 'pending',
      balanceUsdCents: null,
    });

    await issueCard('order-1');

    expect(db.updateBalance).not.toHaveBeenCalled();
    expect(db.appendOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: 'order-1',
        eventType: 'topup_pending',
        payload: expect.objectContaining({ requestId: 'topup_order-1_card-1', cardId: 'card-1' }),
      }),
    );
    expect(db.transitionOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'failed' }),
    );

    const texts = h.sendMessageMock.mock.calls.map((c) => String(c[1]));
    expect(texts.some((t) => t.includes('topup_order-1_card-1'))).toBe(true);
  });

  it('прочий статус топапа (failed) — обычная ошибка, событие topup_pending НЕ пишется', async () => {
    h.topupMock.mockResolvedValue({
      cardId: 'pc-1',
      requestId: 'topup_order-1_card-1',
      status: 'failed',
      balanceUsdCents: null,
    });

    await issueCard('order-1');

    expect(db.appendOrderEvent).not.toHaveBeenCalled();
    expect(db.transitionOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'failed' }),
    );
  });

  it('РЕГРЕСС (HIGH): карту в последние сутки жизни НЕ доливаем — выпускаем новую', async () => {
    // Долив на исходе срока — тихая потеря денег клиента: recycle-cards (03:30)
    // закроет карту через release и вернёт остаток на наш VCC.
    const dayMs = 24 * 60 * 60 * 1000;
    h.dbState.activeCard = { ...activeCard, createdAt: new Date(Date.now() - 179.5 * dayMs) };
    h.createCardMock.mockResolvedValue({
      cardId: 'pc-new',
      panMasked: '****1234',
      pan: '4111111111111234',
      expMonth: 12,
      expYear: 2030,
      cvc: '123',
      balanceUsdCents: 2400,
    });

    await issueCard('order-1');

    expect(h.topupMock).not.toHaveBeenCalled();
    expect(h.createCardMock).toHaveBeenCalledTimes(1);
    // Карту не идлим: она рабочая до конца срока, её закроет cron по возрасту.
    expect(db.markIdle).not.toHaveBeenCalled();
  });

  it('карта моложе порога — обычный долив', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    h.dbState.activeCard = { ...activeCard, createdAt: new Date(Date.now() - 100 * dayMs) };

    await issueCard('order-1');

    expect(h.topupMock).toHaveBeenCalledTimes(1);
    expect(h.createCardMock).not.toHaveBeenCalled();
  });

  it('падение ВСТАВКИ в cards — тот самый сценарий алёрта — тоже спасает реквизиты', async () => {
    // Находка ревью: раньше pendingCredentials заполнялись ПОСЛЕ этой вставки,
    // поэтому спасение не покрывало собственный заявленный сценарий — PAN
    // профинансированной карты терялся навсегда, а тест был зелёным, потому что
    // ронял более позднюю точку (setOrderCardId).
    h.dbState.activeCard = null;
    h.createCardMock.mockResolvedValue({
      cardId: 'pc-new',
      panMasked: '****1234',
      pan: '4111111111111234',
      expMonth: 12,
      expYear: 2030,
      cvc: '123',
      balanceUsdCents: 2400,
    });
    vi.mocked(db.createCard).mockRejectedValueOnce(new Error('БД недоступна'));

    await issueCard('order-1');

    const texts = h.sendMessageMock.mock.calls.map((c) => String(c[1]));
    expect(texts.some((t) => t.includes('4111111111111234'))).toBe(true);
    expect(texts.some((t) => t.includes('pc-new'))).toBe(true);
  });

  it('доставка не удалась — алёрт говорит «НЕ отправлены», а не врёт', async () => {
    // Флаг раньше выставлялся ДО await, а отправка глушит ошибки внутри себя:
    // владелец получал «реквизиты отправлены» там, где их не получил никто.
    h.dbState.activeCard = null;
    h.createCardMock.mockResolvedValue({
      cardId: 'pc-new',
      panMasked: '****1234',
      pan: '4111111111111234',
      expMonth: 12,
      expYear: 2030,
      cvc: '123',
      balanceUsdCents: 2400,
    });
    vi.mocked(db.setOrderCardId).mockRejectedValueOnce(new Error('БД недоступна'));
    // Нет telegram_id — веб-заказ: отправка молча выходит. Именно `Once`:
    // `vi.clearAllMocks()` сбрасывает вызовы, но НЕ реализации, и постоянный
    // мок протёк бы в соседние тесты.
    vi.mocked(db.getUserTelegramId).mockResolvedValueOnce(null);

    await issueCard('order-1');

    const texts = h.sendMessageMock.mock.calls.map((c) => String(c[1]));
    expect(texts.some((t) => t.includes('НЕ отправлены'))).toBe(true);
    expect(texts.some((t) => t.includes('Реквизиты клиенту отправлены'))).toBe(false);
  });

  it('карта выпущена, но БД упала → реквизиты всё равно уходят клиенту', async () => {
    // Деньги с VCC уже списаны, PAN мы принципиально не храним — не отдать
    // реквизиты значит оставить клиента без карты безвозвратно.
    h.dbState.activeCard = null; // форсим выпуск НОВОЙ карты
    h.createCardMock.mockResolvedValue({
      cardId: 'pc-new',
      panMasked: '****1234',
      pan: '4111111111111234',
      expMonth: 12,
      expYear: 2030,
      cvc: '123',
      balanceUsdCents: 2400,
    });
    vi.mocked(db.setOrderCardId).mockRejectedValueOnce(new Error('БД недоступна'));

    await issueCard('order-1');

    expect(h.createCardMock).toHaveBeenCalledTimes(1);

    const texts = h.sendMessageMock.mock.calls.map((c) => String(c[1]));
    // Клиент получил карту, несмотря на сбой записи.
    expect(texts.some((t) => t.includes('4111111111111234'))).toBe(true);
    // Владелец получил providerCardId: без него карту в кабинете PaySpace
    // ищут по сумме и времени.
    expect(texts.some((t) => t.includes('pc-new'))).toBe(true);

    // Заказ всё равно уходит в failed — сводить будет человек.
    expect(db.transitionOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'failed' }),
    );
  });

  it('идемпотентность: claim проигран (transitioned=false) → НЕТ топ-апа (нет двойной траты)', async () => {
    h.dbState.claimTransitioned = false;

    await issueCard('order-1');

    expect(db.transitionOrderDetailed).toHaveBeenCalledTimes(1);
    expect(h.topupMock).not.toHaveBeenCalled();
    expect(h.createCardMock).not.toHaveBeenCalled();
    expect(db.updateBalance).not.toHaveBeenCalled();
    expect(db.transitionOrder).not.toHaveBeenCalled();
  });

  it('PaySpace выключен → ранний выход ДО claim, заказ остаётся в paid', async () => {
    h.paySpaceConfigured.value = false;

    await issueCard('order-1');

    expect(db.transitionOrderDetailed).not.toHaveBeenCalled();
    expect(h.topupMock).not.toHaveBeenCalled();
  });

  it('статус не paid → ранний выход, claim не дёргается', async () => {
    h.dbState.order = { ...baseOrder, status: 'completed' };

    await issueCard('order-1');

    expect(db.transitionOrderDetailed).not.toHaveBeenCalled();
    expect(h.topupMock).not.toHaveBeenCalled();
  });

  it('новая карта: claim успешен, активной нет → createCard + реквизиты в Telegram', async () => {
    h.dbState.activeCard = null;
    h.createCardMock.mockResolvedValue({
      cardId: 'pc-new',
      panMasked: '****1234',
      pan: '4111111111111234',
      expMonth: 12,
      expYear: 2030,
      cvc: '123',
      balanceUsdCents: 2000,
    });

    await issueCard('order-1');

    expect(h.createCardMock).toHaveBeenCalledTimes(1);
    // Новая карта выпускается тоже на сумму с буфером: 2000 → 2400.
    expect(h.createCardMock).toHaveBeenCalledWith({ amountUsdCents: 2400 });
    expect(h.topupMock).not.toHaveBeenCalled();
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining('<b>Тип:</b> <code>Mastercard</code>'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining('<b>Номер:</b> <code>4111111111111234</code>'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining('<b>Street address:</b> <code>350 5th Ave</code>'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.not.stringContaining('SG_SUB'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining('<b>ZIP:</b> <code>10118</code>'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    // Правила оплаты с ценой $20 (original 2000, БЕЗ буфера) + кнопка-инструкция.
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining('$20'),
      expect.objectContaining({ parse_mode: 'HTML', reply_markup: expect.anything() }),
    );
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining('не в мобильном приложении'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.any(String),
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            [
              expect.objectContaining({
                text: 'Открыть прайс сервиса',
                url: 'https://openai.com/chatgpt/pricing/',
              }),
            ],
          ]),
        }),
      }),
    );
    expect(db.transitionOrder).toHaveBeenCalledTimes(1); // → completed
  });

  it('топ-ап отклонён провайдером (PaySpaceApiError) → карта в idle + выпуск НОВОЙ, заказ completed', async () => {
    // Активная карта есть, но провайдер отклоняет топ-ап (напр. карта из чужого
    // окружения при общей БД prod/preview).
    h.topupMock.mockRejectedValue(new h.PaySpaceApiError({ code: 'topup_failed', message: 'rejected' }));
    h.createCardMock.mockResolvedValue({
      cardId: 'pc-new',
      panMasked: '****1234',
      pan: '4111111111111234',
      expMonth: 12,
      expYear: 2030,
      cvc: '123',
      balanceUsdCents: 2400,
    });

    await issueCard('order-1');

    // Сломанную карту вывели из реюза.
    expect(db.markIdle).toHaveBeenCalledTimes(1);
    expect(db.markIdle).toHaveBeenCalledWith(expect.anything(), 'card-1', expect.any(Date), expect.anything());
    // Выпустили новую + реквизиты ушли клиенту.
    expect(h.createCardMock).toHaveBeenCalledTimes(1);
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
    // НЕ updateBalance (топ-ап провалился), заказ доведён до completed (НЕ failed).
    expect(db.updateBalance).not.toHaveBeenCalled();
    expect(db.transitionOrder).toHaveBeenCalledTimes(1);
    expect(db.transitionOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'completed' }),
    );
  });

  it.each([429, 500, 503])(
    'сбой инфраструктуры провайдера (%i без доменного кода) НЕ уводит карту в idle',
    async (httpStatus) => {
      // 429/5xx после ретраев — это «провайдер недоступен», а не «карта мертва».
      // Уведя её в idle, мы лишали клиента реюза и дописывали ему $4 за выпуск
      // новой карты на следующем заказе — а новую выпускали бы ровно в тот
      // момент, когда провайдер и так не отвечает (аудит 2026-08-10).
      h.topupMock.mockRejectedValue(
        new h.PaySpaceApiError({ code: `HTTP_${httpStatus}`, message: 'upstream', httpStatus }),
      );

      await issueCard('order-1');

      expect(db.markIdle).not.toHaveBeenCalled();
      expect(h.createCardMock).not.toHaveBeenCalled();
      expect(db.transitionOrder).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ toStatus: 'failed' }),
      );
    },
  );

  it('доменный код при HTTP 500 — всё равно отказ по существу: карта в idle', async () => {
    // Иначе мёртвая карта осталась бы активной навсегда (`markIdle` — её
    // единственный выход из реюза), и КАЖДЫЙ следующий заказ клиента падал бы
    // одинаково до конца срока жизни карты (ревью 2026-08-11).
    h.topupMock.mockRejectedValue(
      new h.PaySpaceApiError({ code: 'topup_failed', message: 'rejected', httpStatus: 500 }),
    );
    h.createCardMock.mockResolvedValue({
      cardId: 'pc-new',
      panMasked: '****1234',
      pan: '4111111111111234',
      expMonth: 12,
      expYear: 2030,
      cvc: '123',
      balanceUsdCents: 2400,
    });

    await issueCard('order-1');

    expect(db.markIdle).toHaveBeenCalledTimes(1);
    expect(h.createCardMock).toHaveBeenCalledTimes(1);
  });
});
