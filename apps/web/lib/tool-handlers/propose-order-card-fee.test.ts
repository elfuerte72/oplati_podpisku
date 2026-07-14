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

// Rapira ask 80.12 + 3,5% = расчётный курс 82.9242 ₽/USDT (живой API не дёргаем).
vi.mock('../rapira/rates.ts', () => ({
  resolveUsdtRubRate: vi.fn(async () => 82.9242),
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { proposeOrder } from './propose-order.ts';

const BASE = { userId: 'user-1', conversationId: 'conv-1' };

/** Netflix $20: subtotal = round(2000×82.9242); commission = round(subtotal×30%). */
function netflixInput() {
  h.state.service = { id: 'svc-1', slug: 'netflix-premium', isActive: true, requiresKyc: false };
  return { ...BASE, serviceId: 'svc-1', amountUsdCents: 2000 };
}

const SUBTOTAL = 165_848;
const COMMISSION = 49_754;
// Надбавка за выпуск карты: round($4 × 82.9242) = 33 170 копеек (331.70 ₽).
const CARD_FEE = 33_170;

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
    // total = subtotal + commission + fee = 165848 + 49754 + 33170 = 248 772.
    expect(r.totalRubKopecks).toBe(SUBTOTAL + COMMISSION + CARD_FEE);
    expect(h.createDraftOrderMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        amountRub: SUBTOTAL + COMMISSION + CARD_FEE,
        usdtRubRateKopecks: 829_242,
        cardIssueFeeKopecks: CARD_FEE,
      }),
      expect.anything(),
    );
  });

  it('есть активная карта → надбавки нет (топап без issue-fee), снимок = 0', async () => {
    h.findActiveByUserIdMock.mockResolvedValueOnce({ id: 'card-1' });

    const r = await proposeOrder(netflixInput());

    // total = subtotal + commission = 215 602 (без fee).
    expect(r.totalRubKopecks).toBe(SUBTOTAL + COMMISSION);
    expect(h.createDraftOrderMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        amountRub: SUBTOTAL + COMMISSION,
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
