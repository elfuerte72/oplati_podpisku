import { describe, expect, it } from 'vitest';

import {
  FUND_REFILL_BELOW_USD_CENTS,
  FUND_TARGET_USD_CENTS,
  fundTopUpPlan,
  needsRefill,
} from './fund-plan.ts';

/**
 * «Сколько пополнить» — норма рунбука `vcc-funding.md` (пополнять ниже $400,
 * доводить до $900) в коде. Числа здесь — зеркало с рунбуком.
 */
describe('fundTopUpPlan', () => {
  it('норма — та, что в рунбуке: ниже $400 пополнять, доводить до $900', () => {
    expect(FUND_REFILL_BELOW_USD_CENTS).toBe(40_000);
    expect(FUND_TARGET_USD_CENTS).toBe(90_000);
  });

  it('свободного хватает — пополнять не нужно, курс не участвует', () => {
    expect(fundTopUpPlan({ freeUsdCents: 50_000, usdtRubRate: 81, feePercent: 3 })).toEqual({
      state: 'enough',
      freeUsdCents: 50_000,
      refillBelowUsdCents: 40_000,
    });
    // Ровно на границе — ещё хватает.
    expect(needsRefill(40_000)).toBe(false);
    expect(needsRefill(39_999)).toBe(true);
  });

  it('ниже нормы: зачислить до $900, отправить с запасом на комиссию, рубли вверх до целого', () => {
    // $200 свободно → зачислить $700; при 3 % отправить 70000·100/97 = 72164.95 → 72165 центов;
    // 72165 · 81 / 100 = 58453.65 ₽ → 58454 ₽.
    expect(fundTopUpPlan({ freeUsdCents: 20_000, usdtRubRate: 81, feePercent: 3 })).toEqual({
      state: 'refill',
      freeUsdCents: 20_000,
      targetUsdCents: 90_000,
      creditUsdCents: 70_000,
      sendUsdCents: 72_165,
      feePercent: 3,
      rubKopecks: 5_845_400,
      usdtRubRate: 81,
    });
  });

  it('дыра считается целиком: отрицательное свободное увеличивает сумму', () => {
    const plan = fundTopUpPlan({ freeUsdCents: -10_000, usdtRubRate: 80, feePercent: 0 });
    expect(plan).toMatchObject({ state: 'refill', creditUsdCents: 100_000, sendUsdCents: 100_000 });
  });

  it('комиссия 0 — отправить ровно столько, сколько зачислить', () => {
    const plan = fundTopUpPlan({ freeUsdCents: 0, usdtRubRate: 100, feePercent: 0 });
    expect(plan).toMatchObject({ sendUsdCents: 90_000, rubKopecks: 9_000_000 });
  });

  it('мусор на входе бросает, а не молчит', () => {
    expect(() => fundTopUpPlan({ freeUsdCents: 1.5, usdtRubRate: 81, feePercent: 3 })).toThrow();
    expect(() => fundTopUpPlan({ freeUsdCents: 0, usdtRubRate: 0, feePercent: 3 })).toThrow();
    expect(() => fundTopUpPlan({ freeUsdCents: 0, usdtRubRate: 81, feePercent: 100 })).toThrow();
    expect(() => fundTopUpPlan({ freeUsdCents: 0, usdtRubRate: 81, feePercent: -1 })).toThrow();
  });
});
