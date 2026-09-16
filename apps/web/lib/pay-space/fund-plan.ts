/**
 * «Сколько пополнить карточный счёт» — чистая арифметика для раздела «Финансы».
 *
 * Без `server-only` и env намеренно: модуль считает по переданным числам, его
 * гоняют тесты и читает панель. Норма остатка живёт здесь, а не в env: она
 * выведена расчётом по проду 2026-08-19 (`docs/runbooks/vcc-funding.md`) и
 * меняется вместе с разбором в рунбуке, а не тюнингом переменной.
 *
 * ⚠️ Числа нормы — зеркало с таблицей рунбука (инвариант 10): там они
 * цитируются словами «$400» и «$900». Правишь здесь — правь и там.
 */

/** Ниже этого свободного остатка (USD-центы) пора подавать заявку. */
export const FUND_REFILL_BELOW_USD_CENTS = 40_000;
/** До какого свободного остатка (USD-центы) доводить пополнением. */
export const FUND_TARGET_USD_CENTS = 90_000;

/** Пора ли пополнять: свободного меньше нижней отметки нормы. */
export function needsRefill(
  freeUsdCents: number,
  refillBelowUsdCents: number = FUND_REFILL_BELOW_USD_CENTS,
): boolean {
  return freeUsdCents < refillBelowUsdCents;
}

export type FundTopUpPlan =
  /** Свободного хватает — пополнять не нужно. */
  | { state: 'enough'; freeUsdCents: number; refillBelowUsdCents: number }
  | {
      state: 'refill';
      freeUsdCents: number;
      targetUsdCents: number;
      /** Сколько должно ЗАЧИСЛИТЬСЯ на карточный счёт, чтобы дойти до нормы. */
      creditUsdCents: number;
      /** Сколько отправить в PaySpace, чтобы после его комиссии зачислилось нужное. */
      sendUsdCents: number;
      feePercent: number;
      /** Оценка отправляемой суммы в рублях по курсу, округлена вверх до рубля. */
      rubKopecks: number;
      usdtRubRate: number;
    };

/**
 * План пополнения по свободному остатку.
 *
 * `freeUsdCents` может быть отрицательным (обещано больше, чем лежит) — тогда
 * доводить до нормы придётся на всю дыру, и именно это число владелец должен
 * увидеть, а не «пополнить на сумму заказа».
 *
 * Комиссия применяется к ОТПРАВЛЯЕМОЙ сумме: провайдер удерживает процент с
 * пополнения, поэтому `send = credit / (1 − fee)`, округление вверх до цента.
 * Комиссии FKWallet и сети сюда не входят — провайдеры их не публикуют.
 */
export function fundTopUpPlan(input: {
  freeUsdCents: number;
  /** Курс RUB за 1 USDT (≈ USD), как отдаёт Rapira. */
  usdtRubRate: number;
  /** Комиссия PaySpace за пополнение карточного счёта, проценты. */
  feePercent: number;
  refillBelowUsdCents?: number;
  targetUsdCents?: number;
}): FundTopUpPlan {
  const refillBelowUsdCents = input.refillBelowUsdCents ?? FUND_REFILL_BELOW_USD_CENTS;
  const targetUsdCents = input.targetUsdCents ?? FUND_TARGET_USD_CENTS;

  if (!Number.isFinite(input.freeUsdCents) || !Number.isInteger(input.freeUsdCents)) {
    throw new Error(`fundTopUpPlan: свободный остаток не целое число центов: ${input.freeUsdCents}`);
  }
  if (!Number.isFinite(input.usdtRubRate) || input.usdtRubRate <= 0) {
    throw new Error(`fundTopUpPlan: курс должен быть положительным: ${input.usdtRubRate}`);
  }
  if (!Number.isFinite(input.feePercent) || input.feePercent < 0 || input.feePercent >= 100) {
    throw new Error(`fundTopUpPlan: комиссия вне [0, 100): ${input.feePercent}`);
  }

  if (input.freeUsdCents >= refillBelowUsdCents) {
    return { state: 'enough', freeUsdCents: input.freeUsdCents, refillBelowUsdCents };
  }

  const creditUsdCents = targetUsdCents - input.freeUsdCents;
  const sendUsdCents = Math.ceil((creditUsdCents * 100) / (100 - input.feePercent));
  // Центы × курс = копейки (1 USD = 100 центов, курс — рубли за доллар);
  // вверх до целого рубля, как и все цены проекта.
  const rubKopecks = Math.ceil((sendUsdCents * input.usdtRubRate) / 100) * 100;

  return {
    state: 'refill',
    freeUsdCents: input.freeUsdCents,
    targetUsdCents,
    creditUsdCents,
    sendUsdCents,
    feePercent: input.feePercent,
    rubKopecks,
    usdtRubRate: input.usdtRubRate,
  };
}
