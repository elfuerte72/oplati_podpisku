import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Гейты промокода (трек promo-codes): «кому и сколько можно».
 *
 * Здесь проверяется то, чего не видит ни чистая математика (`math.test.ts`), ни
 * PGlite-слой (`promo-codes.integration.test.ts`): решения модуля на стыке —
 * флаг, срок, лимиты, три исхода занятия и КЛЮЧЕВОЕ для мержа поведение
 * «фича выключена → счёт выставляется полный, молча».
 */

const h = vi.hoisted(() => ({
  env: {
    PROMO_CODES_ENABLED: true,
    FREEKASSA_MIN_AMOUNT_RUB: 500,
  },
  state: {
    promo: null as null | {
      id: string;
      code: string;
      discountUsdCents: number;
      capToMargin: boolean;
      minOrderAmountKopecks: number | null;
      perUserLimit: number;
      maxRedemptions: number | null;
      startsAt: Date | null;
      expiresAt: Date | null;
      isActive: boolean;
    },
    counts: { byUser: 0, total: 0 },
    ownRedemption: null as null | {
      orderId: string;
      promoCodeId: string;
      status: 'reserved' | 'spent' | 'released';
      discountKopecks: number;
      discountUsdCents: number;
    },
    findThrows: false,
  },
  reserveMock: vi.fn(async () => ({ ok: true }) as Record<string, unknown>),
  releaseMock: vi.fn(async () => ({ applied: false, redemption: null }) as Record<string, unknown>),
  appendEventMock: vi.fn(async () => {}),
}));

vi.mock('../env.server.ts', () => ({ serverEnv: h.env }));
vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('../payments/gateway.ts', () => ({
  primaryPaymentGateway: () => 'freekassa' as const,
  minAmountRubFor: () => 500,
}));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  PROMO_RELEASED_EVENT: 'promo_released',
  appendOrderEvent: h.appendEventMock,
  findPromoCodeByCode: vi.fn(async () => {
    if (h.state.findThrows) throw new Error('БД недоступна');
    return h.state.promo;
  }),
  countPromoRedemptions: vi.fn(async () => h.state.counts),
  findPromoRedemptionByOrderId: vi.fn(async () => h.state.ownRedemption),
  reservePromoForOrder: h.reserveMock,
  releaseUnusedPromoReservation: h.releaseMock,
  claimPromoSpent: vi.fn(async () => null),
}));

import { checkPromoForOrder, claimPromoForOrder, isPromoEnabled, releasePromoClaim } from './apply.ts';

/** Заказ $20 у клиента без карты: цена 2622 ₽ при курсе 87.36, маржа ~524 ₽. */
const ORDER = {
  id: 'order-1',
  userId: 'user-1',
  amountRub: 2622_00,
  originalAmount: 2000,
  originalCurrency: 'USD',
  cardIssueFeeKopecks: 350_00,
  usdtRubRateKopecks: 873_600,
} as never;

const DARLING = {
  id: 'promo-1',
  code: 'ДАРЛИНГ',
  discountUsdCents: 500,
  capToMargin: false,
  minOrderAmountKopecks: null,
  perUserLimit: 1,
  maxRedemptions: null,
  startsAt: null,
  expiresAt: null,
  isActive: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.env.PROMO_CODES_ENABLED = true;
  h.state.promo = { ...DARLING };
  h.state.counts = { byUser: 0, total: 0 };
  h.state.ownRedemption = null;
  h.state.findThrows = false;
  h.reserveMock.mockResolvedValue({ ok: true });
  h.releaseMock.mockResolvedValue({ applied: false, redemption: null });
});

describe('isPromoEnabled', () => {
  it('читает флаг', () => {
    expect(isPromoEnabled()).toBe(true);
    h.env.PROMO_CODES_ENABLED = false;
    expect(isPromoEnabled()).toBe(false);
  });
});

describe('checkPromoForOrder — гейты', () => {
  it('действующий код даёт скидку', async () => {
    const result = await checkPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.plan.discountKopecks).toBe(436_00);
  });

  it('код нормализуется ПЕРЕД поиском — клиент может набрать как угодно', async () => {
    const db = await import('@oplati/db');
    await checkPromoForOrder({ order: ORDER, code: ' дaр-линг ' });
    expect(db.findPromoCodeByCode).toHaveBeenCalledWith(expect.anything(), 'ДАРЛИНГ');
  });

  it('пустой код отвергается без похода в БД', async () => {
    const db = await import('@oplati/db');
    expect(await checkPromoForOrder({ order: ORDER, code: '   ' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(db.findPromoCodeByCode).not.toHaveBeenCalled();
  });

  it('несуществующий код — not_found', async () => {
    h.state.promo = null;
    expect(await checkPromoForOrder({ order: ORDER, code: 'ЧУЖОЙ' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('⚠️ ВЫКЛЮЧЕННЫЙ код неотличим от несуществующего — поле ввода не оракул', async () => {
    // Разные ответы превратили бы перебор в способ узнать, какие коды заведены,
    // и утекли бы акцию до её запуска.
    h.state.promo = { ...DARLING, isActive: false };
    expect(await checkPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('⚠️ ещё НЕ НАЧАВШАЯСЯ акция неотличима от несуществующего кода', async () => {
    // Иначе перебор находил бы код до объявления кампании и подтверждал, что
    // он существует.
    h.state.promo = { ...DARLING, startsAt: new Date(Date.now() + 86_400_000) };
    expect(await checkPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('срок вышел — expired', async () => {
    h.state.promo = { ...DARLING, expiresAt: new Date(Date.now() - 1000) };
    expect(await checkPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('личный лимит исчерпан — already_used', async () => {
    h.state.counts = { byUser: 1, total: 1 };
    expect(await checkPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' })).toEqual({
      ok: false,
      reason: 'already_used',
    });
  });

  it('общий лимит исчерпан — exhausted', async () => {
    h.state.promo = { ...DARLING, maxRedemptions: 10 };
    h.state.counts = { byUser: 0, total: 10 };
    expect(await checkPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' })).toEqual({
      ok: false,
      reason: 'exhausted',
    });
  });

  it('⚠️ ПОВТОРНЫЙ просмотр своего заказа не упирается в личный лимит', async () => {
    // Клиент применил код к ЭТОМУ заказу и открыл экран снова. Его же занятие
    // считается в `countPromoRedemptions` — без отдельной проверки своей строки
    // он получил бы «ты уже использовал» на собственной живой скидке.
    h.state.counts = { byUser: 1, total: 1 };
    h.state.ownRedemption = {
      orderId: 'order-1',
      promoCodeId: 'promo-1',
      status: 'reserved',
      discountKopecks: 436_00,
      discountUsdCents: 500,
    };
    const result = await checkPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' });
    expect(result.ok).toBe(true);
  });

  it('возвращённое своё занятие лимит уже не прощает', async () => {
    h.state.counts = { byUser: 1, total: 1 };
    h.state.ownRedemption = {
      orderId: 'order-1',
      promoCodeId: 'promo-1',
      status: 'released',
      discountKopecks: 436_00,
      discountUsdCents: 500,
    };
    expect(await checkPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' })).toEqual({
      ok: false,
      reason: 'already_used',
    });
  });

  it('порог суммы заказа не набран — order_too_small', async () => {
    h.state.promo = { ...DARLING, minOrderAmountKopecks: 5000_00 };
    expect(await checkPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' })).toEqual({
      ok: false,
      reason: 'order_too_small',
    });
  });

  it('⚠️ сбой чтения БРОСАЕТ — путь оплаты не должен молча терять скидку', async () => {
    h.state.findThrows = true;
    await expect(checkPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' })).rejects.toThrow();
  });
});

describe('claimPromoForOrder — три исхода', () => {
  it('⚠️ ФИЧА ВЫКЛЮЧЕНА — skipped, счёт полный и молча', async () => {
    // Ровно то состояние, в котором ветка мержится в прод: флаг не задан.
    // Клиент поля не видел, код в теле игнорируется, счёт обычный.
    h.env.PROMO_CODES_ENABLED = false;
    const db = await import('@oplati/db');
    expect(await claimPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' })).toEqual({ kind: 'skipped' });
    expect(db.findPromoCodeByCode).not.toHaveBeenCalled();
    expect(h.reserveMock).not.toHaveBeenCalled();
  });

  it('успешное занятие — claimed с нашим владением', async () => {
    const result = await claimPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' });
    expect(result).toEqual({
      kind: 'claimed',
      owned: true,
      promoCodeId: 'promo-1',
      plan: { discountKopecks: 436_00, discountUsdCents: 500, capped: false },
    });
  });

  it('отказ гейта — unavailable с причиной, а НЕ полный счёт молча', async () => {
    h.state.counts = { byUser: 1, total: 1 };
    expect(await claimPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' })).toEqual({
      kind: 'unavailable',
      reason: 'already_used',
    });
    expect(h.reserveMock).not.toHaveBeenCalled();
  });

  it('⚠️ сбой чтения на пути оплаты — unavailable, а НЕ skipped', async () => {
    // Проглоченная ошибка означала бы полный счёт клиенту, который нажал
    // «оплатить с промокодом»: то самое молчаливое враньё.
    h.state.findThrows = true;
    const result = await claimPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' });
    expect(result.kind).toBe('unavailable');
  });

  it('гонка лимита ВНУТРИ лока — unavailable с причиной репозитория', async () => {
    h.reserveMock.mockResolvedValue({ ok: false, reason: 'exhausted' });
    expect(await claimPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' })).toEqual({
      kind: 'unavailable',
      reason: 'exhausted',
    });
  });

  it('⚠️ already_reserved — НЕ отказ: берём скидку из чужого занятия и не владеем им', async () => {
    // Двойной тап/вторая вкладка. Отдать `unavailable` значило бы ответить
    // «код не сработал» при том, что счёт со скидкой как раз выставляется;
    // а `owned: true` привело бы к освобождению чужого занятия в catch.
    h.reserveMock.mockResolvedValue({
      ok: false,
      reason: 'already_reserved',
      existing: {
        orderId: 'order-1',
        promoCodeId: 'promo-1',
        discountKopecks: 300_00,
        discountUsdCents: 500,
        status: 'reserved',
      },
    });
    const result = await claimPromoForOrder({ order: ORDER, code: 'ДАРЛИНГ' });
    expect(result).toMatchObject({
      kind: 'claimed',
      owned: false,
      plan: { discountKopecks: 300_00 },
    });
  });
});

describe('releasePromoClaim', () => {
  it('снятое занятие пишет событие в журнал заказа', async () => {
    h.releaseMock.mockResolvedValue({
      applied: true,
      redemption: { discountKopecks: 436_00, discountUsdCents: 500, userId: 'user-1' },
    });
    await releasePromoClaim('order-1');
    expect(h.appendEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderId: 'order-1', eventType: 'promo_released' }),
    );
  });

  it('нечего снимать — события нет', async () => {
    await releasePromoClaim('order-1');
    expect(h.appendEventMock).not.toHaveBeenCalled();
  });

  it('⚠️ never-throw: сбой снятия не роняет обработку отказа шлюза', async () => {
    h.releaseMock.mockRejectedValue(new Error('БД недоступна'));
    await expect(releasePromoClaim('order-1')).resolves.toBeUndefined();
  });
});
