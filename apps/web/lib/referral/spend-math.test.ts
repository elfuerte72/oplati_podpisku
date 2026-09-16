import { describe, expect, it } from 'vitest';

import {
  bonusSpendCapKopecks,
  bonusValueKopecks,
  orderCommissionKopecks,
  planBonusSpend,
  type BonusSpendOrder,
} from './spend-math';

/**
 * Worked example спеки (курс 81 ₽, комиссия 30%, надбавка за выпуск $4):
 * Netflix $15.99 → подписка 1684 ₽ + выпуск 324 ₽ = 2008 ₽, комиссия 388,81 ₽.
 * Числа взяты из `propose-order` — та же арифметика, что фиксирует заказ.
 */
const NETFLIX: BonusSpendOrder = {
  amountRub: 200_800,
  originalAmount: 1599,
  cardIssueFeeKopecks: 32_400,
  usdtRubRateKopecks: 810_000,
};

/** Минимум шлюза, при котором усечения не происходит (500 ₽ у L&P). */
const MIN_INVOICE = 50_000;

describe('orderCommissionKopecks', () => {
  it('worked example: комиссия заказа сходится до копейки', () => {
    expect(orderCommissionKopecks(NETFLIX)).toBe(38_881);
  });

  it('заказ без снимка курса или суммы комиссии не имеет — потолка нет', () => {
    expect(orderCommissionKopecks({ ...NETFLIX, usdtRubRateKopecks: null })).toBe(0);
    expect(orderCommissionKopecks({ ...NETFLIX, amountRub: null })).toBe(0);
    expect(orderCommissionKopecks({ ...NETFLIX, originalAmount: null })).toBe(0);
  });

  it('заказ до появления надбавки (fee = null) считается как без надбавки', () => {
    const noFee: BonusSpendOrder = { ...NETFLIX, amountRub: 168_400, cardIssueFeeKopecks: null };
    expect(orderCommissionKopecks(noFee)).toBe(38_881);
  });

  it('отрицательной комиссии не бывает — сломанный снимок даёт ноль', () => {
    expect(orderCommissionKopecks({ ...NETFLIX, amountRub: 10_000 })).toBe(0);
  });

  it('заказ не в USD потолка не даёт: база трактуется как USD-центы', () => {
    // Тот же guard, что в `accrue.ts`. Сегодня каталог всегда USD, но заказ в
    // другой валюте дал бы скидку из чужой маржи.
    expect(orderCommissionKopecks({ ...NETFLIX, originalCurrency: 'EUR' })).toBe(0);
    // NULL — это USD: так пишут все нынешние пути.
    expect(orderCommissionKopecks({ ...NETFLIX, originalCurrency: null })).toBe(38_881);
    expect(orderCommissionKopecks({ ...NETFLIX, originalCurrency: 'USD' })).toBe(38_881);
  });
});

describe('bonusValueKopecks', () => {
  it('паритет: 354 ¢ по курсу 81 ₽ = 286,74 ₽', () => {
    expect(bonusValueKopecks(354, 810_000, 0)).toBe(28_674);
  });

  it('премия за трату — множитель поверх паритета, а не вторая формула', () => {
    expect(bonusValueKopecks(354, 810_000, 20)).toBe(34_408); // 28674 × 1.2
  });

  it('ноль и отрицательный баланс дают ноль', () => {
    expect(bonusValueKopecks(0, 810_000, 0)).toBe(0);
    expect(bonusValueKopecks(-500, 810_000, 0)).toBe(0);
  });
});

describe('planBonusSpend', () => {
  it('worked example: 354 ¢ гасят 286 ₽, счёт остаётся 1722 ₽', () => {
    const plan = planBonusSpend({
      order: NETFLIX,
      balanceUsdCents: 354,
      minInvoiceKopecks: MIN_INVOICE,
      minSpendUsdCents: 100,
      bonusPercent: 0,
    });
    expect(plan).toEqual({ discountKopecks: 28_600, spendUsdCents: 354 });
    expect(NETFLIX.amountRub! - plan!.discountKopecks).toBe(172_200);
  });

  it('баланс больше потолка: скидка упирается в комиссию, округлённую вниз', () => {
    const plan = planBonusSpend({
      order: NETFLIX,
      balanceUsdCents: 10_000,
      minInvoiceKopecks: MIN_INVOICE,
      minSpendUsdCents: 100,
      bonusPercent: 0,
    });
    // Комиссия 388,81 ₽ → вниз до рубля = 388 ₽; списываем ceil(38800/81) = 480 ¢.
    expect(plan).toEqual({ discountKopecks: 38_800, spendUsdCents: 480 });
  });

  it('премия 20% поднимает скидку, но всё равно упирается в потолок комиссии', () => {
    const withBonus = planBonusSpend({
      order: NETFLIX,
      balanceUsdCents: 354,
      minInvoiceKopecks: MIN_INVOICE,
      minSpendUsdCents: 100,
      bonusPercent: 20,
    });
    expect(withBonus?.discountKopecks).toBe(34_400); // 344,08 ₽ → вниз до рубля
    expect(withBonus!.discountKopecks).toBeLessThanOrEqual(bonusSpendCapKopecks({
      order: NETFLIX,
      minInvoiceKopecks: MIN_INVOICE,
    }));

    const huge = planBonusSpend({
      order: NETFLIX,
      balanceUsdCents: 10_000,
      minInvoiceKopecks: MIN_INVOICE,
      minSpendUsdCents: 100,
      bonusPercent: 20,
    });
    expect(huge?.discountKopecks).toBe(38_800);
  });

  it('остаток счёта не опускается ниже минимума шлюза', () => {
    // Дешёвый заказ: 600 ₽, комиссия 138,46 ₽, минимум шлюза 500 ₽ →
    // отдать можно только 100 ₽, а не всю комиссию.
    const cheap: BonusSpendOrder = {
      amountRub: 60_000,
      originalAmount: 570,
      cardIssueFeeKopecks: 0,
      usdtRubRateKopecks: 810_000,
    };
    expect(orderCommissionKopecks(cheap)).toBe(13_830);
    const plan = planBonusSpend({
      order: cheap,
      balanceUsdCents: 10_000,
      minInvoiceKopecks: MIN_INVOICE,
      minSpendUsdCents: 100,
      bonusPercent: 0,
    });
    expect(plan?.discountKopecks).toBe(10_000);
    expect(cheap.amountRub! - plan!.discountKopecks).toBe(MIN_INVOICE);
  });

  it('минимум шлюза съедает скидку целиком — списания нет', () => {
    const atFloor: BonusSpendOrder = {
      amountRub: 50_000,
      originalAmount: 475,
      cardIssueFeeKopecks: 0,
      usdtRubRateKopecks: 810_000,
    };
    expect(
      planBonusSpend({
        order: atFloor,
        balanceUsdCents: 10_000,
        minInvoiceKopecks: MIN_INVOICE,
        minSpendUsdCents: 100,
        bonusPercent: 0,
      }),
    ).toBeNull();
  });

  it('списание ниже $1 не предлагается вовсе', () => {
    const plan = planBonusSpend({
      order: NETFLIX,
      balanceUsdCents: 49,
      minInvoiceKopecks: MIN_INVOICE,
      minSpendUsdCents: 100,
      bonusPercent: 0,
    });
    expect(plan).toBeNull();
  });

  it('ровно $1 списывается', () => {
    const plan = planBonusSpend({
      order: NETFLIX,
      balanceUsdCents: 100,
      minInvoiceKopecks: MIN_INVOICE,
      minSpendUsdCents: 100,
      bonusPercent: 0,
    });
    // 100 ¢ × 81 = 81 ₽ ровно.
    expect(plan).toEqual({ discountKopecks: 8_100, spendUsdCents: 100 });
  });

  it('нулевой и отрицательный баланс расчёт не ломают', () => {
    for (const balanceUsdCents of [0, -1000]) {
      expect(
        planBonusSpend({
          order: NETFLIX,
          balanceUsdCents,
          minInvoiceKopecks: MIN_INVOICE,
          minSpendUsdCents: 100,
          bonusPercent: 0,
        }),
      ).toBeNull();
    }
  });

  it('заказ не в USD предложения не даёт', () => {
    expect(
      planBonusSpend({
        order: { ...NETFLIX, originalCurrency: 'EUR' },
        balanceUsdCents: 10_000,
        minInvoiceKopecks: MIN_INVOICE,
        minSpendUsdCents: 100,
        bonusPercent: 0,
      }),
    ).toBeNull();
  });

  it('заказ без снимка курса предложения не даёт', () => {
    expect(
      planBonusSpend({
        order: { ...NETFLIX, usdtRubRateKopecks: null },
        balanceUsdCents: 10_000,
        minInvoiceKopecks: MIN_INVOICE,
        minSpendUsdCents: 100,
        bonusPercent: 0,
      }),
    ).toBeNull();
  });

  it('списанные центы округляются ВВЕРХ — в нашу пользу, но не больше баланса', () => {
    const plan = planBonusSpend({
      order: NETFLIX,
      balanceUsdCents: 354,
      minInvoiceKopecks: MIN_INVOICE,
      minSpendUsdCents: 100,
      bonusPercent: 0,
    })!;
    // 286 ₽ стоят 353,08 ¢ — берём 354, но никогда больше, чем есть на балансе.
    expect(plan.spendUsdCents).toBe(354);
    expect(plan.spendUsdCents).toBeLessThanOrEqual(354);
    expect(bonusValueKopecks(plan.spendUsdCents, 810_000, 0)).toBeGreaterThanOrEqual(
      plan.discountKopecks,
    );
  });

  it('скидка всегда кратна рублю', () => {
    for (const balance of [123, 777, 1234, 4321]) {
      const plan = planBonusSpend({
        order: NETFLIX,
        balanceUsdCents: balance,
        minInvoiceKopecks: MIN_INVOICE,
        minSpendUsdCents: 100,
        bonusPercent: 0,
      });
      if (!plan) continue;
      expect(plan.discountKopecks % 100).toBe(0);
    }
  });
});

describe('bonusSpendCapKopecks', () => {
  it('потолок — комиссия заказа вниз до рубля', () => {
    expect(bonusSpendCapKopecks({ order: NETFLIX, minInvoiceKopecks: MIN_INVOICE })).toBe(38_800);
  });

  it('минимум шлюза опускает потолок ниже комиссии', () => {
    const cheap: BonusSpendOrder = {
      amountRub: 60_000,
      originalAmount: 570,
      cardIssueFeeKopecks: 0,
      usdtRubRateKopecks: 810_000,
    };
    expect(bonusSpendCapKopecks({ order: cheap, minInvoiceKopecks: MIN_INVOICE })).toBe(10_000);
  });
});

/**
 * Главный экономический инвариант трека: **баллы платятся из маржи заказа,
 * никогда из карточного фонда** (user story 12).
 *
 * Практически это значит, что счёт после скидки обязан покрывать
 * СЕБЕСТОИМОСТЬ заказа — цену подписки по курсу плюс надбавку за выпуск карты.
 * Иначе рублей на карту не хватит, и заказ уйдёт в `failed` уже после приёма
 * денег: ровно тот сценарий, ради которого стоит preflight карточного фонда.
 *
 * Проверяется НЕ на одном примере, а перебором: любая правка потолка или
 * округления, роняющая счёт ниже себестоимости, обязана уронить и этот тест.
 */
describe('счёт после скидки покрывает себестоимость заказа', () => {
  /** Себестоимость: подписка по курсу заказа + надбавка за выпуск карты. */
  function costKopecks(order: BonusSpendOrder): number {
    const subtotal = Math.round((order.originalAmount! * order.usdtRubRateKopecks!) / 10_000);
    return subtotal + (order.cardIssueFeeKopecks ?? 0);
  }

  const rates = [700_000, 810_000, 950_000];
  const prices = [500, 999, 1599, 4999, 12_000];
  const balances = [100, 354, 1000, 5000, 100_000];
  const premiums = [0, 20, 100];

  it('при любом сочетании цены, курса, баланса и премии', () => {
    for (const rate of rates) {
      for (const priceUsdCents of prices) {
        // Цена собирается ровно так же, как её фиксирует `propose_order`:
        // подписка вверх до рубля, надбавка отдельной строкой.
        const subtotal = Math.round((priceUsdCents * rate) / 10_000);
        const commission = Math.round((subtotal * 30) / 100);
        const subscription = Math.ceil((subtotal + commission) / 100) * 100;
        const fee = Math.ceil(Math.round(400 * (rate / 10_000)) / 100) * 100;
        const order: BonusSpendOrder = {
          amountRub: subscription + fee,
          originalAmount: priceUsdCents,
          originalCurrency: 'USD',
          cardIssueFeeKopecks: fee,
          usdtRubRateKopecks: rate,
        };

        for (const balanceUsdCents of balances) {
          for (const bonusPercent of premiums) {
            const plan = planBonusSpend({
              order,
              balanceUsdCents,
              minInvoiceKopecks: 50_000,
              minSpendUsdCents: 100,
              bonusPercent,
            });
            if (!plan) continue;
            const invoice = order.amountRub! - plan.discountKopecks;
            const label = `цена ${priceUsdCents}¢, курс ${rate}, баланс ${balanceUsdCents}¢, премия ${bonusPercent}%`;

            // Себестоимость покрыта — карту будет на что выпустить.
            expect(invoice, label).toBeGreaterThanOrEqual(costKopecks(order));
            // Минимум шлюза не пробит.
            expect(invoice, label).toBeGreaterThanOrEqual(50_000);
            // Списано не больше, чем есть на балансе.
            expect(plan.spendUsdCents, label).toBeLessThanOrEqual(balanceUsdCents);
          }
        }
      }
    }
  });
});
