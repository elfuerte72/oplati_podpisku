import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv (кэшируется на весь файл).
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
// Фиксируем комиссию и минимум терминала для детерминизма расчёта.
process.env.COMMISSION_PERCENT = '30';
process.env.LOVEANDPAY_MIN_AMOUNT_RUB = '500';

type ServiceLike = { id: string; slug: string; isActive: boolean; requiresKyc: boolean };

const h = vi.hoisted(() => ({
  createDraftOrderMock: vi.fn(async () => ({ id: 'order-1', shortId: 'AB12' })),
  state: {
    service: null as ServiceLike | null,
    recentOrders: 0,
  },
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  countRecentOrdersByUser: vi.fn(async () => h.state.recentOrders),
  getServiceById: vi.fn(async () => h.state.service),
  createDraftOrder: h.createDraftOrderMock,
}));

// Курс USDT→RUB фиксируем (живой L&P не дёргаем): 77 ₽/USDT.
vi.mock('../loveandpay/rates.ts', () => ({
  resolveUsdtRubRate: vi.fn(async () => 77),
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { OrderAmountOutOfBoundsError, proposeOrder } from './propose-order.ts';

const BASE = { userId: 'user-1', conversationId: 'conv-1' };

/** Заказ по каталожному сервису с заданным slug. */
function catalogInput(slug: string, amountUsdCents: number) {
  h.state.service = { id: 'svc-1', slug, isActive: true, requiresKyc: false };
  return { ...BASE, serviceId: 'svc-1', amountUsdCents };
}

/** Заказ вне каталога (свободный текст, serviceId отсутствует). */
function customInput(amountUsdCents: number) {
  h.state.service = null;
  return { ...BASE, customDescription: 'Какой-то сервис', amountUsdCents };
}

beforeEach(() => {
  h.state.service = null;
  h.state.recentOrders = 0;
  h.createDraftOrderMock.mockClear();
});

describe('proposeOrder — service-aware потолок суммы', () => {
  describe('высоколимитные сервисы (airbnb/booking/steam) — до $5000', () => {
    it('Airbnb $610 (>$500) → заказ создаётся, расчёт по курсу+комиссии', async () => {
      const r = await proposeOrder(catalogInput('airbnb', 61_000));
      expect(r.orderId).toBe('order-1');
      expect(r.isCustom).toBe(false);
      // subtotal = 61000 × 77 = 4 697 000 коп.; commission 30% = 1 409 100; total = 6 106 100.
      expect(h.createDraftOrderMock).toHaveBeenCalledTimes(1);
      expect(h.createDraftOrderMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ amountRub: 6_106_100, originalAmount: 61_000, originalCurrency: 'USD' }),
        expect.anything(),
      );
    });

    it('Booking ровно $5000 → ок (граница включительно)', async () => {
      const r = await proposeOrder(catalogInput('booking', 500_000));
      expect(r.orderId).toBe('order-1');
    });

    it('Steam $5001 (>$5000) → throws, заказ НЕ создаётся', async () => {
      await expect(proposeOrder(catalogInput('steam', 500_100))).rejects.toBeInstanceOf(
        OrderAmountOutOfBoundsError,
      );
      expect(h.createDraftOrderMock).not.toHaveBeenCalled();
    });
  });

  describe('обычные сервисы и custom — потолок $500', () => {
    it('обычный каталожный сервис $600 → throws (slug не в high-value)', async () => {
      await expect(proposeOrder(catalogInput('netflix-premium', 60_000))).rejects.toBeInstanceOf(
        OrderAmountOutOfBoundsError,
      );
      expect(h.createDraftOrderMock).not.toHaveBeenCalled();
    });

    it('custom-описание $600 → throws (свободный текст остаётся на $500)', async () => {
      await expect(proposeOrder(customInput(60_000))).rejects.toBeInstanceOf(
        OrderAmountOutOfBoundsError,
      );
      expect(h.createDraftOrderMock).not.toHaveBeenCalled();
    });

    it('обычный каталожный сервис ровно $500 → ок (граница)', async () => {
      const r = await proposeOrder(catalogInput('netflix-premium', 50_000));
      expect(r.orderId).toBe('order-1');
      expect(r.isCustom).toBe(false);
    });
  });

  describe('нижняя граница и валидность', () => {
    it('$0.50 (<$1) → throws даже для airbnb', async () => {
      await expect(proposeOrder(catalogInput('airbnb', 50))).rejects.toBeInstanceOf(
        OrderAmountOutOfBoundsError,
      );
      expect(h.createDraftOrderMock).not.toHaveBeenCalled();
    });
  });
});
