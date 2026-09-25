import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    reverseAccrualsMock: vi.fn(async () => 0),
    PaySpaceApiError,
    paySpaceConfigured: { value: true },
    dbState: {
      order: null as OrderLike | null,
      claimTransitioned: true,
      activeCard: null as Record<string, unknown> | null,
      serviceSlug: 'chatgpt-plus' as string | null,
      serviceInstructions: {
        requiresVpn: true,
        vpnLocation: 'США',
        paymentUrl: 'https://chatgpt.com/#pricing',
      } as Record<string, unknown> | null,
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
  // Как настоящая строка каталога: название + правила оплаты со ссылкой на
  // оформление (seed-catalog `usInstructions`). `serviceInstructions: null` —
  // сервис без записи правил, кнопка откатывается на официальный прайс.
  getServiceById: vi.fn(async () =>
    h.dbState.serviceSlug
      ? {
          slug: h.dbState.serviceSlug,
          name: 'ChatGPT',
          paymentInstructions: h.dbState.serviceInstructions,
        }
      : null,
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

// Закрепление адреса ходит в БД (`getOrAssignUserBillingAddress`) — его
// подменяем. Адрес при этом берём из НАСТОЯЩЕГО пула, а форматирование
// оставляем настоящим: выдуманный в тесте адрес проверял бы сообщение клиенту
// на том, чего клиент никогда не получит.
vi.mock('../billing-address.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../billing-address.ts')>();
  return {
    ...actual,
    resolveBillingAddressForUser: vi.fn(async () => actual.BILLING_ADDRESS_POOL[0]),
  };
});

vi.mock('../telegram/bot.ts', () => ({
  getBot: () => ({ api: { sendMessage: h.sendMessageMock } }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// Реферальный реверс (R-1): по контракту graceful — сам никогда не бросает.
vi.mock('../referral/reverse.ts', () => ({
  reverseReferralAccrualsForFailedOrder: h.reverseAccrualsMock,
}));

import * as db from '@oplati/db';
import { BILLING_ADDRESS_POOL, resolveBillingAddressForUser } from '../billing-address.ts';
import { reverseReferralAccrualsForFailedOrder } from '../referral/reverse.ts';
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
    h.dbState.serviceInstructions = {
      requiresVpn: true,
      vpnLocation: 'США',
      paymentUrl: 'https://chatgpt.com/#pricing',
    };
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
      expect.stringContaining('Карта для ChatGPT пополнена'),
      expect.objectContaining({ parse_mode: 'HTML', reply_markup: expect.anything() }),
    );
    // Реквизиты при пополнении — по кнопке, а не в тексте: PAN в чате не повторяем.
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining('по кнопке «Карта в приложении»'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    // Закреплённый адрес приходит и при пополнении: клиент с картой, выпущенной
    // до 2026-09-21, получал адрес от генератора фейков и настоящий видит здесь
    // впервые.
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining(`<b>Street address:</b> <code>${BILLING_ADDRESS_POOL[0].streetLine1}</code>`),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.any(String),
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          // Та же ссылка, что у «Перейти на сайт сервиса» в Mini App
          // (`payment_instructions.paymentUrl`), а не прайс: чат и кабинет не
          // должны вести клиента в разные места.
          inline_keyboard: [
            [
              expect.objectContaining({
                text: '🌐 Открыть ChatGPT',
                url: 'https://chatgpt.com/#pricing',
              }),
            ],
            [
              expect.objectContaining({
                text: '💳 Карта в приложении',
                web_app: expect.objectContaining({ url: expect.stringMatching(/\/cabinet$/) }),
              }),
            ],
            [expect.objectContaining({ text: '📖 Как оплатить — пошагово' })],
          ],
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
    // Без названия сервиса текст говорит нейтрально, а не «для null».
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining('Карта для оплаты подписки пополнена'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.any(String),
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: [
            [expect.objectContaining({ text: '💳 Карта в приложении' })],
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
    expect(db.transitionOrderDetailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'failed' }),
    );

    const texts = h.sendMessageMock.mock.calls.map((c) => String(c[1]));
    expect(texts.some((t) => t.includes('topup_order-1_card-1'))).toBe(true);
  });

  it('провал фулфилмента гасит реферальное начисление заказа (R-1)', async () => {
    // Иначе комиссия за неисполненный заказ остаётся у партнёра навсегда:
    // recovery её уже не досчитывает, а витрина и оборот такой заказ не видят —
    // ledger был единственным местом, где failed продолжал приносить деньги.
    h.topupMock.mockRejectedValue(new h.PaySpaceApiError({ code: 'topup_failed', message: 'no' }));
    h.createCardMock.mockRejectedValue(new h.PaySpaceApiError({ code: 'denied', message: 'no' }));

    await issueCard('order-1');

    expect(db.transitionOrderDetailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'failed' }),
    );
    expect(reverseReferralAccrualsForFailedOrder).toHaveBeenCalledWith('order-1');
  });

  it('отмена идёт ПОСЛЕ перехода в failed, а не до (T-2)', async () => {
    // Гейт отмены живёт в SQL: `JOIN orders o ON ... o.status IN (failed, ...)`.
    // Позови её до коммита перехода — запрос увидит заказ ещё в
    // `in_fulfillment`, погасит ноль строк и вернёт 0 БЕЗ ошибки. Проверка
    // «оба мока вызваны» такую перестановку не ловит (находка QA).
    h.topupMock.mockRejectedValue(new h.PaySpaceApiError({ code: 'topup_failed', message: 'no' }));
    h.createCardMock.mockRejectedValue(new h.PaySpaceApiError({ code: 'denied', message: 'no' }));

    await issueCard('order-1');

    const failedAt = vi
      .mocked(db.transitionOrderDetailed)
      .mock.invocationCallOrder.at(
        vi
          .mocked(db.transitionOrderDetailed)
          .mock.calls.findIndex((c) => (c[1] as { toStatus?: string }).toStatus === 'failed'),
      );
    const reversedAt = vi.mocked(reverseReferralAccrualsForFailedOrder).mock.invocationCallOrder[0];
    expect(failedAt).toBeDefined();
    expect(reversedAt).toBeDefined();
    expect(reversedAt!).toBeGreaterThan(failedAt!);
  });

  it('успешный заказ начисление НЕ трогает', async () => {
    h.topupMock.mockResolvedValue({
      cardId: 'pc-1',
      requestId: 'topup_order-1_card-1',
      status: 'completed',
      balanceUsdCents: 2000,
    });
    h.dbState.activeCard = activeCard;

    await issueCard('order-1');

    expect(reverseReferralAccrualsForFailedOrder).not.toHaveBeenCalled();
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
    expect(db.transitionOrderDetailed).toHaveBeenCalledWith(
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
    expect(db.transitionOrderDetailed).toHaveBeenCalledWith(
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
    // Адрес — закреплённый за ИМЕННО этим клиентом, а не случайный на вызов.
    expect(resolveBillingAddressForUser).toHaveBeenCalledWith(expect.anything(), 'user-1');
    const address = BILLING_ADDRESS_POOL[0];
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining(`<b>Street address:</b> <code>${address.streetLine1}</code>`),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.not.stringContaining('SG_SUB'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining(`<b>ZIP:</b> <code>${address.postalCode}</code>`),
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
          // Та же ссылка, что у «Перейти на сайт сервиса» в Mini App
          // (`payment_instructions.paymentUrl`), а не прайс: чат и кабинет не
          // должны вести клиента в разные места.
          inline_keyboard: [
            [
              expect.objectContaining({
                text: '🌐 Открыть ChatGPT',
                url: 'https://chatgpt.com/#pricing',
              }),
            ],
            [
              expect.objectContaining({
                text: '💳 Карта в приложении',
                web_app: expect.objectContaining({ url: expect.stringMatching(/\/cabinet$/) }),
              }),
            ],
            [expect.objectContaining({ text: '📖 Как оплатить — пошагово' })],
          ],
        }),
      }),
    );
    expect(db.transitionOrder).toHaveBeenCalledTimes(1); // → completed
  });

  describe('текст сообщения с новой картой (разбор пути клиента 2026-09-23)', () => {
    async function sentCardMessage(): Promise<string> {
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
      expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
      return String(h.sendMessageMock.mock.calls[0]?.[1]);
    }

    it('сначала что дали и что сделать самому, потом реквизиты, адрес и правила', async () => {
      // Прежнее сообщение открывалось «Оплатить строго по цене $X» и правилами:
      // клиент читал его как «доплатите» и ждал, что подписку подключат за него.
      const text = await sentCardMessage();

      const intro = text.indexOf('Карта для ChatGPT готова');
      const ownStep = text.indexOf('Последний шаг делаешь ты');
      const number = text.indexOf('<b>Номер:</b>');
      const address = text.indexOf('Адрес плательщика');
      const rules = text.indexOf('Чтобы оплата прошла с первого раза');
      expect(text.startsWith('<b>Карта для ChatGPT готова.</b>')).toBe(true);
      expect([intro, ownStep, number, address, rules].every((i) => i >= 0)).toBe(true);
      expect(intro).toBeLessThan(ownStep);
      expect(ownStep).toBeLessThan(number);
      expect(number).toBeLessThan(address);
      expect(address).toBeLessThan(rules);
      expect(text).toContain('оформи подписку за $20 и заплати этой картой');
    });

    it('не обещает ответа в чате и не путает «ты» с «вы»', async () => {
      // Бот на свободный текст отвечает «в переписке я не отвечаю»
      // (BOT_AI_ENABLED выключен) — «напишите сюда, проверю» было ложным обещанием.
      const text = await sentCardMessage();

      expect(text).not.toContain('напишите');
      expect(text).not.toContain('вводите');
      expect(text).not.toContain('Оплатить строго');
      expect(text).toContain('/support');
      expect(text).toContain('Номер заказа: ORD-AAAAA');
    });

    it('страна выпуска карты не называется — «США» только у VPN и адреса', async () => {
      const text = await sentCardMessage();

      expect(text).not.toMatch(/карт[а-я]*\s+(США|американ)/i);
    });

    it('тип карты неизвестен → строки «Тип» нет, а не «не указан»', async () => {
      h.getCardInfoMock.mockResolvedValue({
        cardId: 'pc-new',
        panMasked: '411111******1234',
        statusCode: '1',
        statusLabel: 'activated',
        balanceUsdCents: 2400,
        expDate: '12/30',
        cardType: null,
        productCode: 'SG_SUB',
      });

      const text = await sentCardMessage();

      expect(text).not.toContain('Тип:');
      expect(text).not.toContain('не указан');
    });

    it('у сервиса нет записи правил → кнопка ведёт на официальный прайс', async () => {
      h.dbState.serviceInstructions = null;

      await sentCardMessage();

      expect(h.sendMessageMock).toHaveBeenCalledWith(
        '12345',
        expect.any(String),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.arrayContaining([
              [
                expect.objectContaining({
                  text: '🌐 Открыть ChatGPT',
                  url: 'https://openai.com/chatgpt/pricing/',
                }),
              ],
            ]),
          }),
        }),
      );
    });
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
      expect(db.transitionOrderDetailed).toHaveBeenCalledWith(
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

  /**
   * Клиент заплатил, а выдача упала: раньше он не получал НИЧЕГО — тревога
   * уходила персоналу, клиенту тишина (разбор бэклога 2026-09-24). Сообщения
   * клиенту уходят в его чат (12345), тревоги — в ops-чат (111222333).
   */
  describe('сообщение клиенту о сбое выдачи', () => {
    const FAILURE_MARK = 'выдать карту автоматически не получилось';

    // Реализацию отправки один тест подменяет; `clearAllMocks` её не снимает.
    afterEach(() => {
      h.sendMessageMock.mockReset();
    });

    function clientTexts(): string[] {
      return h.sendMessageMock.mock.calls
        .filter((c) => String(c[0]) === '12345')
        .map((c) => String(c[1]));
    }

    function opsTexts(): string[] {
      return h.sendMessageMock.mock.calls
        .filter((c) => String(c[0]) !== '12345')
        .map((c) => String(c[1]));
    }

    it('карты нет вовсе → клиенту одно сообщение с номером заказа и кнопкой «Поддержка»', async () => {
      h.topupMock.mockRejectedValue(new h.PaySpaceApiError({ code: 'topup_failed', message: 'no' }));
      h.createCardMock.mockRejectedValue(new h.PaySpaceApiError({ code: 'denied', message: 'no' }));

      await issueCard('order-1');

      const failure = h.sendMessageMock.mock.calls.filter((c) => String(c[1]).includes(FAILURE_MARK));
      expect(failure).toHaveLength(1);
      expect(String(failure[0]?.[0])).toBe('12345');
      expect(String(failure[0]?.[1])).toContain('ORD-AAAAA');
      // Та же кнопка, что под подсказкой и в меню: callback `support`.
      expect(JSON.stringify(failure[0]?.[2])).toContain('"callback_data":"support"');
      expect(opsTexts().some((t) => t.includes('отправлено сообщение о задержке'))).toBe(true);
    });

    it('сообщение уходит ПОСЛЕ тревоги персоналу: оно обещает, что оператор уже знает', async () => {
      h.topupMock.mockRejectedValue(new h.PaySpaceApiError({ code: 'topup_failed', message: 'no' }));
      h.createCardMock.mockRejectedValue(new h.PaySpaceApiError({ code: 'denied', message: 'no' }));

      await issueCard('order-1');

      const calls = h.sendMessageMock.mock.calls;
      const clientAt = calls.findIndex((c) => String(c[1]).includes(FAILURE_MARK));
      const opsAt = calls.findIndex((c) => String(c[1]).includes('выпуск карты упал'));
      expect(opsAt).toBeGreaterThanOrEqual(0);
      expect(clientAt).toBeGreaterThan(opsAt);
    });

    it('пополнение зависло (исход неизвестен) → клиенту тоже пишем', async () => {
      h.topupMock.mockResolvedValue({
        cardId: 'pc-1',
        requestId: 'topup_order-1_card-1',
        status: 'pending',
        balanceUsdCents: null,
      });

      await issueCard('order-1');

      expect(clientTexts().filter((t) => t.includes(FAILURE_MARK))).toHaveLength(1);
    });

    it('реквизиты уже дошли, а запись у нас упала → о сбое клиенту НЕ пишем', async () => {
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

      await issueCard('order-1');

      expect(clientTexts().some((t) => t.includes('4111111111111234'))).toBe(true);
      expect(clientTexts().some((t) => t.includes(FAILURE_MARK))).toBe(false);
      expect(opsTexts().some((t) => t.includes('не писали'))).toBe(true);
    });

    it('«карта пополнена» уже дошло, а запись у нас упала → о сбое клиенту НЕ пишем', async () => {
      vi.mocked(db.setOrderCardId).mockRejectedValueOnce(new Error('БД недоступна'));

      await issueCard('order-1');

      expect(clientTexts().some((t) => t.includes('пополнена'))).toBe(true);
      expect(clientTexts().some((t) => t.includes(FAILURE_MARK))).toBe(false);
    });

    it('реквизиты НЕ дошли (спасение сорвалось) → о сбое пишем', async () => {
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
      // Обе отправки реквизитов (штатная и спасение) отвергнуты Telegram.
      h.sendMessageMock.mockImplementation(async (chatId: unknown, text: unknown) => {
        if (String(chatId) === '12345' && String(text).includes('4111111111111234')) {
          throw new Error('telegram 500');
        }
        return {};
      });

      await issueCard('order-1');

      expect(clientTexts().filter((t) => t.includes(FAILURE_MARK))).toHaveLength(1);
    });

    it('заказ уже был в failed (повтор) → переход не состоялся, клиенту НЕ пишем повторно', async () => {
      h.topupMock.mockRejectedValue(new h.PaySpaceApiError({ code: 'topup_failed', message: 'no' }));
      h.createCardMock.mockRejectedValue(new h.PaySpaceApiError({ code: 'denied', message: 'no' }));
      vi.mocked(db.transitionOrderDetailed)
        .mockResolvedValueOnce({ order: { status: 'in_fulfillment' }, transitioned: true } as never)
        .mockResolvedValueOnce({ order: { status: 'failed' }, transitioned: false } as never);

      await issueCard('order-1');

      expect(clientTexts().some((t) => t.includes(FAILURE_MARK))).toBe(false);
    });

    it('неверная сумма заказа → клиенту пишем (деньги получены, карты нет)', async () => {
      h.dbState.order = { ...baseOrder, originalAmount: 0 };

      await issueCard('order-1');

      expect(clientTexts().filter((t) => t.includes(FAILURE_MARK))).toHaveLength(1);
    });
  });
});
