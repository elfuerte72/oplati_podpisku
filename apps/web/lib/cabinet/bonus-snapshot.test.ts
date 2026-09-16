import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Что экран заказа Mini App получает про баллы (критерий приёмки тикета 05).
 *
 * Проверяется СНАПШОТ, а не гейты по отдельности: между `loadBonusSpendState` и
 * экраном лежит `buildOrderDetail`, и ошибка ровно здесь — блок, посчитанный
 * для заказа, у которого списывать уже поздно, или отсутствие блока у клиента с
 * баллами — видна только на этом стыке.
 */

const h = vi.hoisted(() => ({
  order: null as Record<string, unknown> | null,
  balance: 1000,
  spendEnabled: true,
}));

vi.mock('../env.server.ts', () => ({
  serverEnv: {
    REFERRAL_ENABLED: true,
    get REFERRAL_SPEND_ENABLED() {
      return h.spendEnabled;
    },
    REFERRAL_SPEND_ALLOWLIST: '',
    REFERRAL_SPEND_MIN_USD_CENTS: 100,
    REFERRAL_SPEND_RATE_BONUS_PERCENT: 0,
    LOVEANDPAY_MIN_AMOUNT_RUB: 500,
  },
}));
vi.mock('@/lib/env.server', () => ({
  serverEnv: {
    REFERRAL_ENABLED: true,
    get REFERRAL_SPEND_ENABLED() {
      return h.spendEnabled;
    },
    REFERRAL_SPEND_ALLOWLIST: '',
    REFERRAL_SPEND_MIN_USD_CENTS: 100,
    REFERRAL_SPEND_RATE_BONUS_PERCENT: 0,
  },
}));
vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('../payments/gateway.ts', () => ({
  primaryPaymentGateway: () => 'loveandpay' as const,
  minAmountRubFor: () => 500,
  buyerFeePercentForOrder: () => 0,
}));
vi.mock('../contacts/phone-gate.ts', () => ({ phoneRequirementRub: () => null }));
vi.mock('../alerts/notify-staff.ts', () => ({ notifyStaff: vi.fn(async () => ({})) }));
vi.mock('./live-balance.ts', () => ({ withLiveBalance: async (_db: unknown, c: unknown[]) => c }));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  getOrderById: vi.fn(async () => h.order),
  getOrdersByUserId: vi.fn(async () => []),
  getOrderEventsByOrderId: vi.fn(async () => []),
  getServiceById: vi.fn(async () => null),
  getServicesByIds: vi.fn(async () => []),
  getUserProfileById: vi.fn(async () => null),
  findCardsByUserIdForCabinet: vi.fn(async () => []),
  findPaymentsByOrderId: vi.fn(async () => []),
  findRedemptionByOrderId: vi.fn(async () => null),
  findPromoRedemptionByOrderId: vi.fn(async () => null),
  findPromoRedemptionsByOrderIds: vi.fn(async () => new Map()),
  findRedemptionsByOrderIds: vi.fn(async () => new Map()),
  getReferralBalanceUsdCents: vi.fn(async () => h.balance),
  getUserTelegramId: vi.fn(async () => '42'),
  getPartnerProfile: vi.fn(async () => ({ suspended: false })),
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

import { buildOrderDetail } from './read.ts';

/** Netflix из worked example: 2008 ₽, комиссия 388,81 ₽, курс 81. */
function order(over: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    userId: 'user-1',
    shortId: 'ORD-1',
    status: 'ready_for_payment',
    amountRub: 200_800,
    originalAmount: 1599,
    originalCurrency: 'USD',
    commissionPercent: 30,
    usdtRubRateKopecks: 810_000,
    cardIssueFeeKopecks: 32_400,
    serviceId: null,
    customServiceDescription: 'Netflix',
    cardId: null,
    createdAt: new Date('2026-09-10T10:00:00Z'),
    expiresAt: new Date('2026-09-10T12:00:00Z'),
    paidAt: null,
    fulfilledAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.spendEnabled = true;
  h.balance = 1000;
  h.order = order();
});

describe('снапшот экрана заказа — блок баллов', () => {
  it('есть что списать: предложение и потолок посчитаны', async () => {
    const detail = await buildOrderDetail('user-1', 'order-1');

    expect(detail?.bonusOffer).toEqual({
      balanceUsdCents: 1000,
      balanceKopecks: 81_000,
      capKopecks: 38_800,
      offer: { discountKopecks: 38_800, spendUsdCents: 480 },
      minSpendUsdCents: 100,
    });
  });

  it('баланс ниже минимума: блок есть, предложения нет — «баллы копятся»', async () => {
    h.balance = 40;

    const detail = await buildOrderDetail('user-1', 'order-1');

    expect(detail?.bonusOffer?.offer).toBeNull();
    expect(detail?.bonusOffer?.balanceKopecks).toBe(3_240);
  });

  it('клиент без баллов блока не получает вовсе', async () => {
    h.balance = 0;

    expect((await buildOrderDetail('user-1', 'order-1'))?.bonusOffer).toBeNull();
  });

  it('выключенный флаг убирает блок при любом балансе', async () => {
    h.spendEnabled = false;

    expect((await buildOrderDetail('user-1', 'order-1'))?.bonusOffer).toBeNull();
  });

  it('заказ, который уже нельзя оплатить, предложения не получает', async () => {
    // Списывать некуда: заказ не поедет к оплате.
    h.order = order({ status: 'completed' });

    expect((await buildOrderDetail('user-1', 'order-1'))?.bonusOffer).toBeNull();
  });

  it('чужой заказ не отдаётся вместе с балансом владельца', async () => {
    expect(await buildOrderDetail('someone-else', 'order-1')).toBeNull();
  });
});
