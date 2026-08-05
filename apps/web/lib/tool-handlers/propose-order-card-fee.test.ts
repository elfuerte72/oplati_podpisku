import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv (кэшируется на весь файл).
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
// Фиксируем комиссию/минимум и ВКЛЮЧАЕМ надбавку за выпуск карты ($4 = 400 центов).
// Отдельный файл — свой модульный кэш serverEnv, поэтому fee активен только здесь
// (в propose-order.test.ts CARD_ISSUE_FEE_USD_CENTS не задан → дефолт 0, суммы без fee).
process.env.COMMISSION_PERCENT = '30';
process.env.LOVEANDPAY_MIN_AMOUNT_RUB = '500';
process.env.CARD_ISSUE_FEE_USD_CENTS = '400';

type ServiceLike = { id: string; slug: string; isActive: boolean; requiresKyc: boolean };

const h = vi.hoisted(() => ({
  createDraftOrderMock: vi.fn(async () => ({ id: 'order-1', shortId: 'AB12' })),
  findActiveByUserIdMock: vi.fn(async () => null as { id: string } | null),
  state: {
    service: null as ServiceLike | null,
    activeCard: null as { id: string } | null,
  },
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  countRecentOrdersByUser: vi.fn(async () => 0),
  getServiceById: vi.fn(async () => h.state.service),
  createDraftOrder: h.createDraftOrderMock,
  findActiveByUserId: h.findActiveByUserIdMock,
}));

// Курс USDT→RUB фиксируем по примеру Rapira (живой API не дёргаем): 80.12 ₽/USDT.
vi.mock('../rapira/rates.ts', () => ({
  resolveUsdtRubRate: vi.fn(async () => 80.12),
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { proposeOrder } from './propose-order.ts';

const BASE = { userId: 'user-1', conversationId: 'conv-1' };

/** Заказ Netflix $20. subtotal = 2000×80.12 = 160 240; commission 30% = 48 072. */
function netflixInput() {
  h.state.service = { id: 'svc-1', slug: 'netflix-premium', isActive: true, requiresKyc: false };
  return { ...BASE, serviceId: 'svc-1', amountUsdCents: 2000 };
}

// Цена клиента — без копеек, вверх: 160 240 + 48 072 = 208 312 → 208 400 (2084 ₽).
const SUBSCRIPTION = 208_400;
// Надбавка за выпуск карты: $4 × 80.12 = 320,48 ₽ → вверх до 321 ₽ = 32 100 копеек.
const CARD_FEE = 32_100;

beforeEach(() => {
  h.state.service = null;
  h.state.activeCard = null;
  h.createDraftOrderMock.mockClear();
  h.findActiveByUserIdMock.mockClear();
});

describe('proposeOrder — разовая надбавка за выпуск карты', () => {
  it('нет активной карты → надбавка $4 добавлена в total и записана снимком', async () => {
    h.findActiveByUserIdMock.mockResolvedValueOnce(null);

    const r = await proposeOrder(netflixInput());

    expect(r.orderId).toBe('order-1');
    // total = подписка + fee = 208 400 + 32 100 = 240 500 (2405 ₽, без копеек).
    expect(r.totalRubKopecks).toBe(SUBSCRIPTION + CARD_FEE);
    expect(r.totalRubKopecks % 100).toBe(0);
    expect(h.createDraftOrderMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        amountRub: SUBSCRIPTION + CARD_FEE,
        cardIssueFeeKopecks: CARD_FEE,
      }),
      expect.anything(),
    );
  });

  it('обе строки чека целые: total − fee (строка «Подписка») тоже без копеек', async () => {
    h.findActiveByUserIdMock.mockResolvedValueOnce(null);

    const r = await proposeOrder(netflixInput());

    // Экран заказа рисует «Подписка» как total − cardIssueFeeKopecks — она
    // обязана быть целой, иначе разбивка выглядит рванее итога.
    expect((r.totalRubKopecks - CARD_FEE) % 100).toBe(0);
    expect(r.totalRubKopecks - CARD_FEE).toBe(SUBSCRIPTION);
  });

  it('есть активная карта → надбавки нет (топап без issue-fee), снимок = 0', async () => {
    h.findActiveByUserIdMock.mockResolvedValueOnce({ id: 'card-1' });

    const r = await proposeOrder(netflixInput());

    // total = только подписка, 208 400 (без fee).
    expect(r.totalRubKopecks).toBe(SUBSCRIPTION);
    expect(h.createDraftOrderMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        amountRub: SUBSCRIPTION,
        cardIssueFeeKopecks: 0,
      }),
      expect.anything(),
    );
  });

  it('наличие карты определяется по findActiveByUserId(userId)', async () => {
    h.findActiveByUserIdMock.mockResolvedValueOnce(null);
    await proposeOrder(netflixInput());
    expect(h.findActiveByUserIdMock).toHaveBeenCalledWith(expect.anything(), 'user-1');
  });
});
