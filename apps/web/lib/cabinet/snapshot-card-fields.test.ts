import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Читающие добавления в сводку заказа (трек miniapp-tabs, тикет 06):
 * `cardId` и `subscriptionActivated`. По ним вкладка «Карта» решает, показывать
 * ли «Остался один шаг» и какие заказы относятся к карте.
 *
 * Денежных полей не добавляется, и снапшот по-прежнему не несёт ни PAN, ни CVC:
 * карта из БД (с `providerCardId` и прочим) уходит клиенту только маской.
 */

const h = vi.hoisted(() => ({
  orders: [] as Record<string, unknown>[],
  cards: [] as Record<string, unknown>[],
  activated: new Set<string>(),
  events: [] as Record<string, unknown>[],
  order: null as Record<string, unknown> | null,
  eventQueries: [] as { orderIds: readonly string[]; eventType: string }[],
  withLive: vi.fn(async (_db: unknown, cards: unknown[]) => cards),
}));

vi.mock('../env.server.ts', () => ({
  serverEnv: {
    REFERRAL_ENABLED: false,
    REFERRAL_SPEND_ENABLED: false,
    REFERRAL_SPEND_ALLOWLIST: '',
    REFERRAL_SPEND_MIN_USD_CENTS: 100,
    REFERRAL_SPEND_RATE_BONUS_PERCENT: 0,
  },
}));
vi.mock('@/lib/env.server', () => ({
  serverEnv: { REFERRAL_ENABLED: false, REFERRAL_SPEND_ENABLED: false, REFERRAL_SPEND_ALLOWLIST: '' },
}));
vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('../payments/gateway.ts', () => ({
  primaryPaymentGateway: () => 'freekassa' as const,
  minAmountRubFor: () => 500,
  buyerFeePercentForOrder: () => 0,
}));
vi.mock('../contacts/phone-gate.ts', () => ({ phoneRequirementRub: () => null }));
vi.mock('../promo/apply.ts', () => ({ isPromoEnabled: () => false }));
vi.mock('./live-balance.ts', () => ({
  withLiveBalance: h.withLive,
  pickPrimaryCard: (cards: readonly Record<string, unknown>[]) => cards[0] ?? null,
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  getOrderById: vi.fn(async () => h.order),
  getOrdersByUserId: vi.fn(async () => h.orders),
  getOrderEventsByOrderId: vi.fn(async () => h.events),
  getServiceById: vi.fn(async () => null),
  getServicesByIds: vi.fn(async () => []),
  getUserProfileById: vi.fn(async () => null),
  findCardsByUserIdForCabinet: vi.fn(async () => h.cards),
  findPaymentsByOrderId: vi.fn(async () => []),
  findRedemptionByOrderId: vi.fn(async () => null),
  findPromoRedemptionByOrderId: vi.fn(async () => null),
  findPromoRedemptionsByOrderIds: vi.fn(async () => new Map()),
  findRedemptionsByOrderIds: vi.fn(async () => new Map()),
  findOrderIdsWithEvent: vi.fn(async (_db: unknown, input: { orderIds: readonly string[]; eventType: string }) => {
    h.eventQueries.push(input);
    return new Set(input.orderIds.filter((id) => h.activated.has(id)));
  }),
  getReferralBalanceUsdCents: vi.fn(async () => 0),
  BONUS_RELEASED_EVENT: 'bonus_released',
  BONUS_RESERVED_EVENT: 'bonus_reserved',
  BONUS_SPENT_EVENT: 'bonus_spent',
  PROMO_RELEASED_EVENT: 'promo_released',
  PROMO_RESERVED_EVENT: 'promo_reserved',
  PROMO_SPENT_EVENT: 'promo_spent',
  PAYMENT_BLOCKED_CAPACITY_EVENT: 'payment_blocked_capacity',
  PAYMENT_REMINDER_FAILED_EVENT: 'payment_reminder_failed',
  PAYMENT_REMINDER_SENT_EVENT: 'payment_reminder_sent',
  PAYMENT_REVIEW_CLIENT_NOTIFIED_EVENT: 'payment_review_client_notified',
}));

import { buildCardLive, buildOrderDetail, buildSnapshot } from './read.ts';

const PAN = '5592680100101726';
const CVC = '167';

function orderRow(over: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    userId: 'user-1',
    shortId: 'ORD-1',
    status: 'completed',
    amountRub: 246_000,
    originalAmount: 2000,
    originalCurrency: 'USD',
    commissionPercent: 30,
    usdtRubRateKopecks: 810_000,
    cardIssueFeeKopecks: 32_800,
    serviceId: null,
    customServiceDescription: 'ChatGPT',
    cardId: 'card-1',
    createdAt: new Date('2026-09-22T10:00:00Z'),
    expiresAt: null,
    paidAt: new Date('2026-09-22T10:05:00Z'),
    fulfilledAt: new Date('2026-09-22T10:07:00Z'),
    ...over,
  };
}

function cardRow() {
  return {
    id: 'card-1',
    userId: 'user-1',
    providerCardId: 'prov-777',
    panMasked: '•••• 1726',
    status: 'active',
    balanceUsdCents: 2000,
    createdAt: new Date('2026-09-22T10:07:00Z'),
    // На случай, если строка БД когда-нибудь понесёт лишнее: в снапшот это
    // попасть не должно — mapCard берёт только разрешённые поля.
    pan: PAN,
    cvc: CVC,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.orders = [];
  h.cards = [];
  h.activated = new Set();
  h.events = [];
  h.order = null;
  h.eventQueries = [];
  h.withLive.mockImplementation(async (_db: unknown, cards: unknown[]) => cards);
});

describe('buildSnapshot — cardId и subscriptionActivated в сводке заказа', () => {
  it('поля есть: заказ по карте без отметки о подписке', async () => {
    h.orders = [orderRow()];
    h.cards = [cardRow()];

    const snapshot = await buildSnapshot('user-1');

    expect(snapshot.orders[0]).toMatchObject({ cardId: 'card-1', subscriptionActivated: false });
  });

  it('отметка «Подписка оформлена» видна в сводке', async () => {
    h.orders = [orderRow()];
    h.activated = new Set(['order-1']);

    const snapshot = await buildSnapshot('user-1');

    expect(snapshot.orders[0]?.subscriptionActivated).toBe(true);
  });

  it('заказ без карты — cardId null', async () => {
    h.orders = [orderRow({ id: 'order-2', status: 'pending_payment', cardId: null })];

    const snapshot = await buildSnapshot('user-1');

    expect(snapshot.orders[0]).toMatchObject({ cardId: null, subscriptionActivated: false });
  });

  it('признак читается ОДНИМ запросом по всем заказам и ровно этого события', async () => {
    h.orders = [orderRow(), orderRow({ id: 'order-2' }), orderRow({ id: 'order-3' })];

    await buildSnapshot('user-1');

    expect(h.eventQueries).toEqual([
      { orderIds: ['order-1', 'order-2', 'order-3'], eventType: 'subscription_activated' },
    ]);
  });

  it('PAN и CVC в снапшот не попадают', async () => {
    h.orders = [orderRow()];
    h.cards = [cardRow()];

    const json = JSON.stringify(await buildSnapshot('user-1'));

    expect(json).not.toContain(PAN);
    expect(json).not.toContain(`"${CVC}"`);
    expect(json).not.toContain('prov-777');
  });
});

describe('buildOrderDetail — те же поля на экране заказа', () => {
  it('subscriptionActivated из событий заказа', async () => {
    h.order = orderRow();
    h.events = [
      {
        eventType: 'subscription_activated',
        toStatus: null,
        createdAt: new Date('2026-09-22T11:00:00Z'),
      },
    ];

    const detail = await buildOrderDetail('user-1', 'order-1');

    expect(detail).toMatchObject({ cardId: 'card-1', subscriptionActivated: true });
  });

  it('без события — false', async () => {
    h.order = orderRow();

    const detail = await buildOrderDetail('user-1', 'order-1');

    expect(detail?.subscriptionActivated).toBe(false);
  });
});

/**
 * Живой баланс карты ушёл из снапшота в отдельное действие: PaySpace отвечает
 * ~1,2 с, и снапшот нёс это ожидание в каждое открытие кабинета.
 */
describe('живой баланс — отдельно от снапшота', () => {
  it('снапшот в PaySpace не ходит: баланс карты — из БД', async () => {
    h.cards = [cardRow()];

    const snapshot = await buildSnapshot('user-1');

    expect(h.withLive).not.toHaveBeenCalled();
    expect(snapshot.cards[0]?.balanceUsdCents).toBe(2000);
  });

  it('buildCardLive отдаёт живой баланс и срок основной карты — и больше ничего', async () => {
    h.cards = [cardRow()];
    h.withLive.mockImplementation(async (_db: unknown, cards: unknown[]) =>
      (cards as Record<string, unknown>[]).map((c) => ({ ...c, balanceUsdCents: 315, liveExpDate: '01/27' })),
    );

    const live = await buildCardLive('user-1');

    // Срок сети — январь 2027, наш — март 2027 (180 дней от 22.09.2026):
    // «Действует до» берёт более ранний, то есть конец января.
    expect(live).toEqual({ cardId: 'card-1', balanceUsdCents: 315, validUntil: '2027-01-31T20:59:59.000Z' });
    // Ни PAN, ни CVC, ни идентификатора провайдера наружу.
    expect(JSON.stringify(live)).not.toContain(PAN);
    expect(JSON.stringify(live)).not.toContain('prov-777');
  });

  it('PaySpace не ответил — БД-значения, срок по нашему правилу', async () => {
    h.cards = [cardRow()];

    const live = await buildCardLive('user-1');

    expect(live?.balanceUsdCents).toBe(2000);
    expect(live?.validUntil).toBe(new Date(Date.parse('2026-09-22T10:07:00Z') + 180 * 86_400_000).toISOString());
  });

  it('карты нет — null, в PaySpace не ходим', async () => {
    const live = await buildCardLive('user-1');

    expect(live).toBeNull();
    expect(h.withLive).not.toHaveBeenCalled();
  });
});
