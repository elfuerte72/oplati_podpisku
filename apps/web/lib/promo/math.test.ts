import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  env: { REFERRAL_SPEND_RATE_BONUS_PERCENT: 0, REFERRAL_SPEND_MIN_USD_CENTS: 100 },
}));
vi.mock('@/lib/env', () => ({ serverEnv: hoisted.env }));

import { bonusSpendCapKopecks, planBonusSpend } from '../referral/spend-math.ts';
import { planPromoDiscount, promoNominalKopecks, type PromoRules } from './math.ts';

/**
 * Экономика промокода (трек promo-codes). Числа взяты боевые: курс 81 ₽,
 * комиссия 30%, выпуск карты $4 ≈ 324 ₽, минимум счёта Freekassa 500 ₽.
 *
 * Здесь же закреплено решение владельца 2026-09-11: **$5 выдаются целиком даже
 * когда это уводит заказ в минус**. Тест на убыточный заказ стоит намеренно —
 * он документирует, что это не дефект.
 */

const RATE = 81 * 10_000; // 81 ₽ × 10000
const MIN_INVOICE = 500_00; // 500 ₽ в копейках

/** Заказ по правилам прода: subtotal + 30% + $4 за карту, вверх до рубля. */
function order(subtotalUsdCents: number, opts: { cardFee?: boolean } = {}) {
  const cardIssueFeeKopecks = opts.cardFee === false ? 0 : Math.ceil((400 * RATE) / 10_000 / 100) * 100;
  const subtotalKopecks = Math.round((subtotalUsdCents * RATE) / 10_000);
  const withCommission = Math.ceil((subtotalKopecks * 1.3) / 100) * 100;
  return {
    amountRub: withCommission + cardIssueFeeKopecks,
    originalAmount: subtotalUsdCents,
    originalCurrency: 'USD',
    cardIssueFeeKopecks,
    usdtRubRateKopecks: RATE,
  };
}

/** ДАРЛИНГ: $5, маржой НЕ ограничен, порога нет. */
const DARLING: PromoRules = {
  discountUsdCents: 500,
  capToMargin: false,
  minOrderAmountKopecks: null,
};

describe('promoNominalKopecks', () => {
  it('$5 по курсу 81 — это 405 ₽', () => {
    expect(promoNominalKopecks(500, RATE)).toBe(405_00);
  });

  it('нулевой и отрицательный вход дают 0, а не мусор', () => {
    expect(promoNominalKopecks(0, RATE)).toBe(0);
    expect(promoNominalKopecks(-500, RATE)).toBe(0);
    expect(promoNominalKopecks(500, 0)).toBe(0);
  });

  it('округление ВНИЗ — копейка округления наша, а не клиента', () => {
    // $0.01 по курсу 81,0001 ₽ = 81,0001 коп → 81, а не 82.
    expect(promoNominalKopecks(1, 810_001)).toBe(81);
  });
});

describe('planPromoDiscount — ДАРЛИНГ ($5, без потолка маржи)', () => {
  it('на дорогом заказе даёт полные 405 ₽ и не урезан', () => {
    // $20 подписка: цена ≈ 2430 ₽, маржа ≈ 486 ₽ — $5 помещается целиком.
    const result = planPromoDiscount({
      order: order(2000),
      promo: DARLING,
      minInvoiceKopecks: MIN_INVOICE,
    });
    expect(result).toEqual({
      ok: true,
      plan: { discountKopecks: 405_00, discountUsdCents: 500, capped: false },
    });
  });

  it('на заказе с маржой МЕНЬШЕ $5 всё равно даёт все 405 ₽ — решение владельца', () => {
    // $10 подписка: цена ≈ 1377 ₽, маржа ≈ 243 ₽. Скидка 405 ₽ больше маржи —
    // заказ уходит в минус, и это осознанный маркетинговый расход.
    const o = order(1000);
    const result = planPromoDiscount({
      order: o,
      promo: DARLING,
      minInvoiceKopecks: MIN_INVOICE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.plan.discountKopecks).toBe(405_00);
    expect(result.plan.capped).toBe(false);
    // Счёт остаётся выше минимума шлюза — иначе он бы не выставился.
    expect(o.amountRub - result.plan.discountKopecks).toBeGreaterThanOrEqual(MIN_INVOICE);
  });

  it('скидка усекается минимумом шлюза и об этом сказано (capped)', () => {
    // Заказ ровно на 800 ₽: до минимума 500 ₽ есть только 300 ₽ запаса.
    const result = planPromoDiscount({
      order: { ...order(1000), amountRub: 800_00 },
      promo: DARLING,
      minInvoiceKopecks: MIN_INVOICE,
    });
    expect(result).toEqual({
      ok: true,
      plan: { discountKopecks: 300_00, discountUsdCents: 500, capped: true },
    });
  });

  it('на заказе ровно в минимум шлюза скидки нет вовсе', () => {
    // Запаса ноль: любая скидка опустила бы счёт ниже 500 ₽.
    expect(
      planPromoDiscount({
        order: { ...order(1000), amountRub: MIN_INVOICE },
        promo: DARLING,
        minInvoiceKopecks: MIN_INVOICE,
      }),
    ).toEqual({ ok: false, reason: 'no_headroom' });
  });

  it('минимум шлюза действует и при выключенном потолке маржи', () => {
    // capToMargin:false отменяет потолок МАРЖИ, но не физический предел шлюза.
    const result = planPromoDiscount({
      order: { ...order(1000), amountRub: 600_00 },
      promo: DARLING,
      minInvoiceKopecks: MIN_INVOICE,
    });
    expect(result.ok && result.plan.discountKopecks).toBe(100_00);
  });
});

describe('planPromoDiscount — потолок маржи (capToMargin: true)', () => {
  const capped: PromoRules = { ...DARLING, capToMargin: true };

  it('скидка не превышает комиссию заказа', () => {
    // $10 подписка: маржа ≈ 243 ₽ — меньше номинала 405 ₽.
    const result = planPromoDiscount({
      order: order(1000),
      promo: capped,
      minInvoiceKopecks: MIN_INVOICE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.plan.discountKopecks).toBeLessThan(405_00);
    expect(result.plan.capped).toBe(true);
  });

  it('на дорогом заказе маржи хватает — выдаётся полный номинал', () => {
    const result = planPromoDiscount({
      order: order(2000),
      promo: capped,
      minInvoiceKopecks: MIN_INVOICE,
    });
    expect(result.ok && result.plan.discountKopecks).toBe(405_00);
  });
});

describe('planPromoDiscount — порог суммы заказа', () => {
  const fromTwoThousand: PromoRules = { ...DARLING, minOrderAmountKopecks: 2000_00 };

  it('заказ ниже порога — код не применяется ВОВСЕ, а не урезается', () => {
    expect(
      planPromoDiscount({
        order: order(1000),
        promo: fromTwoThousand,
        minInvoiceKopecks: MIN_INVOICE,
      }),
    ).toEqual({ ok: false, reason: 'order_too_small' });
  });

  it('заказ от порога — полная скидка', () => {
    const result = planPromoDiscount({
      order: order(2000),
      promo: fromTwoThousand,
      minInvoiceKopecks: MIN_INVOICE,
    });
    expect(result.ok && result.plan.discountKopecks).toBe(405_00);
  });
});

describe('planPromoDiscount — неполный снимок заказа', () => {
  it('заказ без курса скидки не получает', () => {
    expect(
      planPromoDiscount({
        order: { ...order(1000), usdtRubRateKopecks: null },
        promo: DARLING,
        minInvoiceKopecks: MIN_INVOICE,
      }),
    ).toEqual({ ok: false, reason: 'no_headroom' });
  });

  it('заказ без суммы скидки не получает', () => {
    expect(
      planPromoDiscount({
        order: { ...order(1000), amountRub: null },
        promo: DARLING,
        minInvoiceKopecks: MIN_INVOICE,
      }),
    ).toEqual({ ok: false, reason: 'no_headroom' });
  });
});

/**
 * Порядок «промокод первый, баллы вторые» — инвариант трека. Здесь проверяется
 * то, ради чего он заведён: баллы не должны тратить маржу, которую промокод уже
 * съел, и не должны опускать счёт ниже минимума шлюза.
 */
describe('взаимодействие с баллами', () => {
  beforeEach(() => {
    hoisted.env.REFERRAL_SPEND_RATE_BONUS_PERCENT = 0;
    hoisted.env.REFERRAL_SPEND_MIN_USD_CENTS = 100;
  });

  it('потолок баллов уменьшается на скидку промокода', () => {
    const o = order(2000); // маржа ≈ 486 ₽
    const without = bonusSpendCapKopecks({ order: o, minInvoiceKopecks: MIN_INVOICE });
    const withPromo = bonusSpendCapKopecks({
      order: o,
      minInvoiceKopecks: MIN_INVOICE,
      promoDiscountKopecks: 405_00,
    });
    expect(withPromo).toBe(without - 405_00);
  });

  it('промокод, съевший всю маржу, обнуляет потолок баллов', () => {
    // $10: маржа ≈ 243 ₽, промокод дал 405 ₽ — маржи не осталось совсем.
    expect(
      bonusSpendCapKopecks({
        order: order(1000),
        minInvoiceKopecks: MIN_INVOICE,
        promoDiscountKopecks: 405_00,
      }),
    ).toBe(0);
    // И списывать баллы по такому заказу не предлагается вовсе.
    expect(
      planBonusSpend({
        order: order(1000),
        balanceUsdCents: 10_000,
        minInvoiceKopecks: MIN_INVOICE,
        promoDiscountKopecks: 405_00,
      }),
    ).toBeNull();
  });

  it('баллы не могут опустить счёт ниже минимума шлюза с учётом промокода', () => {
    // Заказ 600 ₽ у клиента с картой (fee=0): подписка $5.70 ≈ 461,70 ₽,
    // маржа ≈ 138 ₽. Промокод дал 50 ₽ → счёт 550 ₽, до минимума 500 ₽ ровно
    // 50 ₽. Связывает ИМЕННО запас до минимума (маржи осталось 88 ₽), и
    // считается он от УЖЕ уменьшенного счёта, а не от полной цены заказа.
    const o = {
      amountRub: 600_00,
      originalAmount: 570,
      originalCurrency: 'USD',
      cardIssueFeeKopecks: 0,
      usdtRubRateKopecks: RATE,
    };
    expect(
      bonusSpendCapKopecks({
        order: o,
        minInvoiceKopecks: MIN_INVOICE,
        promoDiscountKopecks: 50_00,
      }),
    ).toBe(50_00);
  });

  it('без промокода поведение баллов не меняется (обратная совместимость)', () => {
    const o = order(2000);
    expect(bonusSpendCapKopecks({ order: o, minInvoiceKopecks: MIN_INVOICE })).toBe(
      bonusSpendCapKopecks({ order: o, minInvoiceKopecks: MIN_INVOICE, promoDiscountKopecks: 0 }),
    );
  });

  it('сумма двух скидок не опускает счёт ниже минимума шлюза', () => {
    // Богатый баланс на заказе, где промокод уже забрал часть запаса: счёт
    // обязан остаться выставимым при любой комбинации скидок.
    for (const subtotal of [1000, 2000, 5000, 12_000]) {
      const o = order(subtotal);
      const promo = planPromoDiscount({
        order: o,
        promo: DARLING,
        minInvoiceKopecks: MIN_INVOICE,
      });
      const promoKopecks = promo.ok ? promo.plan.discountKopecks : 0;
      const bonus = planBonusSpend({
        order: o,
        balanceUsdCents: 100_000,
        minInvoiceKopecks: MIN_INVOICE,
        promoDiscountKopecks: promoKopecks,
      });
      const invoice = (o.amountRub ?? 0) - promoKopecks - (bonus?.discountKopecks ?? 0);
      expect(invoice).toBeGreaterThanOrEqual(MIN_INVOICE);
    }
  });
});
