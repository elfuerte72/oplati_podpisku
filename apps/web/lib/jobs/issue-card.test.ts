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
process.env.ALERT_TELEGRAM_CHAT_ID = '379336096';

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
    constructor(opts: { code: string; message: string }) {
      super(opts.message);
      this.name = 'PaySpaceApiError';
      this.code = opts.code;
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
  findRecyclableCard: vi.fn(async () => null),
  createCard: vi.fn(async () => ({ id: 'card-new', providerCardId: 'pc-new', panMasked: '****1234' })),
  markActive: vi.fn(async () => {}),
  markIdle: vi.fn(async () => {}),
  updateBalance: vi.fn(async () => {}),
  setOrderCardId: vi.fn(async () => {}),
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

  it('topup завис в pending → заказ НЕ завершаем, уходим в failed', async () => {
    h.topupMock.mockResolvedValue({
      cardId: 'pc-1',
      requestId: 'topup_order-1_card-1',
      status: 'pending',
      balanceUsdCents: null,
    });

    await issueCard('order-1');

    // balance не трогаем, заказ не completed — только переход в failed.
    expect(db.updateBalance).not.toHaveBeenCalled();
    expect(db.transitionOrder).toHaveBeenCalledTimes(1);
    expect(db.transitionOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'failed' }),
    );
    // Прямой ops-алерт владельцу: оплаченный заказ не доехал.
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
    expect(h.sendMessageMock).toHaveBeenCalledWith(
      '379336096',
      expect.stringContaining('НЕ доставлен'),
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
});
