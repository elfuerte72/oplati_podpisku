import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv (кэшируется на весь файл).
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.COMMISSION_PERCENT = '30';
// Деньги принимает Freekassa, а минимумы шлюзов РАЗНЫЕ — ровно тот разъезд,
// из-за которого пол суммы, зашитый на L&P, давал непроходимые заказы и
// неверную цифру в тексте клиенту (аудит 2026-08-10).
process.env.PAYMENT_PRIMARY_PROVIDER = 'freekassa';
process.env.FREEKASSA_API_KEY = 'api-key';
process.env.FREEKASSA_SHOP_ID = '777';
process.env.FREEKASSA_SECRET_WORD_2 = 'secret-2';
process.env.LOVEANDPAY_MIN_AMOUNT_RUB = '500';
process.env.FREEKASSA_MIN_AMOUNT_RUB = '3000';

type ServiceLike = { id: string; slug: string; isActive: boolean; requiresKyc: boolean };

const h = vi.hoisted(() => ({
  createDraftOrderMock: vi.fn(async () => ({ id: 'order-1', shortId: 'AB12' })),
  state: { service: null as ServiceLike | null },
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  countRecentOrdersByUser: vi.fn(async () => 0),
  getServiceById: vi.fn(async () => h.state.service),
  createDraftOrder: h.createDraftOrderMock,
  findActiveByUserId: vi.fn(async () => null),
}));

vi.mock('../rapira/rates.ts', () => ({
  resolveUsdtRubRate: vi.fn(async () => 80.12),
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { proposeOrder } from './propose-order.ts';

const BASE = { userId: 'user-1', conversationId: 'conv-1' };

function orderFor(amountUsdCents: number) {
  h.state.service = { id: 'svc-1', slug: 'netflix-premium', isActive: true, requiresKyc: false };
  return { ...BASE, serviceId: 'svc-1', amountUsdCents };
}

beforeEach(() => {
  h.state.service = null;
  h.createDraftOrderMock.mockClear();
});

describe('proposeOrder — пол суммы берётся у АКТИВНОГО шлюза', () => {
  it('РЕГРЕСС: $20 (2084 ₽) проходит пол L&P, но не проходит пол Freekassa', async () => {
    // Заказ дороже минимума L&P (500 ₽) и дешевле минимума текущего шлюза
    // (3000 ₽): раньше он создавался и оказывался неоплатимым — `payments/create`
    // отвечал `below_min_amount` уже после подтверждения клиентом.
    await expect(proposeOrder(orderFor(2000))).rejects.toThrow(/3000/);
    expect(h.createDraftOrderMock).not.toHaveBeenCalled();
  });

  it('текст ошибки называет минимум того же шлюза, что проверял условие', async () => {
    await expect(proposeOrder(orderFor(2000))).rejects.toThrow(
      /ниже минимума 3000 ₽/,
    );
  });

  it('заказ выше минимума текущего шлюза создаётся', async () => {
    await expect(proposeOrder(orderFor(5000))).resolves.toMatchObject({ orderId: 'order-1' });
    expect(h.createDraftOrderMock).toHaveBeenCalledTimes(1);
  });
});
