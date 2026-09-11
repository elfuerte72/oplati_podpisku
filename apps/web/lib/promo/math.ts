import type { PromoRejectReason } from '@oplati/types';

import { roundDownToWholeRubles } from '../pricing.ts';
import { orderCommissionKopecks, type BonusSpendOrder } from '../referral/spend-math.ts';

/**
 * Математика скидки по промокоду (трек promo-codes, §«Инварианты» п. 3).
 *
 * Чистые функции без БД и без сети: их зовут ДВЕ точки — витрина экрана заказа
 * в Mini App (сколько обещать) и `payments/create` (сколько списать на самом
 * деле). Обе обязаны звать одну функцию: разъезд означает, что клиент увидел
 * одну скидку, а счёт ушёл на другую сумму.
 *
 * Курс берётся ТОЛЬКО из снимка заказа, никогда из живого Rapira — клиент видит
 * скидку в тех же рублях, в которых посчитана цена. То же правило, что у баллов.
 *
 * ⚠️ Чем промокод отличается от баллов. Баллы платятся из маржи и потолком
 * имеют комиссию заказа, поэтому рублей всегда хватает на выпуск карты.
 * Промокод такого обещания НЕ даёт: при `capToMargin: false` (так заведён
 * ДАРЛИНГ) номинал выдаётся целиком, и на заказе дешевле ~2100 ₽ мы уходим в
 * минус. Это решение владельца 2026-09-11 — маркетинговый расход, а не дефект.
 * Единственное, что остаётся жёстким, — минимум шлюза: счёт ниже него просто не
 * выставится.
 */

/** Курс хранится как `rate × 10000` (фиксированная точка, 4 знака). */
const RATE_SCALE = 10_000;

/** Правила кода — ровно те колонки `promo_codes`, что влияют на арифметику. */
export type PromoRules = {
  discountUsdCents: number;
  capToMargin: boolean;
  minOrderAmountKopecks: number | null;
};

export type PromoDiscountPlan = {
  /** На сколько уменьшится счёт, RUB-копейки. Всегда кратно рублю и > 0. */
  discountKopecks: number;
  /** Снимок номинала, по которому скидка посчитана (USD-центы). */
  discountUsdCents: number;
  /**
   * Урезали ли номинал. Экран обязан сказать об этом вслух: обещали $5, дали
   * меньше — молчание здесь превращается в обращение в поддержку.
   */
  capped: boolean;
};

export type PromoDiscountResult =
  | { ok: true; plan: PromoDiscountPlan }
  | { ok: false; reason: Extract<PromoRejectReason, 'order_too_small' | 'no_headroom'> };

/**
 * Во сколько RUB-копеек превращается номинал промокода по курсу заказа.
 *
 * Считаем в целых: `usdCents × rateKopecks` при делении на `10000` помещается в
 * safe integer с запасом, а произведение float дало бы хвост вида
 * `40499.999999999996` — то есть рубль скидки то туда, то сюда.
 *
 * Округление ВНИЗ до копейки, затем вниз до рубля — величина, которую мы
 * ОТДАЁМ, и копейка округления идёт нам, а не клиенту. То же направление, что у
 * `bonusValueKopecks`.
 */
export function promoNominalKopecks(usdCents: number, rateKopecks: number): number {
  if (!Number.isFinite(usdCents) || usdCents <= 0) return 0;
  if (!Number.isFinite(rateKopecks) || rateKopecks <= 0) return 0;
  return Math.floor((usdCents * rateKopecks) / RATE_SCALE);
}

/**
 * Сколько скидки даст этот промокод по этому заказу.
 *
 * Порядок ровно такой:
 *  1. порог суммы заказа — если он задан и не набран, код не применяется ВОВСЕ
 *     («действует от N ₽»), а не применяется урезанным: обещание либо честное,
 *     либо его нет;
 *  2. номинал по курсу заказа;
 *  3. потолок по марже — ТОЛЬКО если `capToMargin`;
 *  4. headroom до минимума счёта — ВСЕГДА: это физический предел провайдера,
 *     и он не отменяется никаким флагом;
 *  5. вниз до целого рубля; ноль — отказ `no_headroom`, а не «скидка 0 ₽».
 *
 * `minInvoiceKopecks` — минимум АКТИВНОГО шлюза. У Freekassa это 500 ₽, поэтому
 * заказ на 700 ₽ получит не 405 ₽ скидки, а 200 ₽: ниже 500 ₽ счёт не уйдёт.
 */
export function planPromoDiscount(input: {
  order: BonusSpendOrder;
  promo: PromoRules;
  minInvoiceKopecks: number;
}): PromoDiscountResult {
  const { order, promo, minInvoiceKopecks } = input;

  const amountRub = order.amountRub ?? 0;
  const rateKopecks = order.usdtRubRateKopecks ?? 0;
  if (amountRub <= 0 || rateKopecks <= 0) {
    // Неполный снимок заказа: считать скидку не от чего. Клиенту это выглядит
    // как «код к этому заказу не применить» — честнее, чем скидка наугад.
    return { ok: false, reason: 'no_headroom' };
  }

  if (promo.minOrderAmountKopecks !== null && amountRub < promo.minOrderAmountKopecks) {
    return { ok: false, reason: 'order_too_small' };
  }

  const nominal = promoNominalKopecks(promo.discountUsdCents, rateKopecks);
  if (nominal <= 0) return { ok: false, reason: 'no_headroom' };

  // Физический предел провайдера — единственное ограничение, которое действует
  // всегда. Оно же причина, по которой промокод в $5 не работает на заказах
  // дешевле ~905 ₽: там до минимума счёта просто нет 405 рублей запаса.
  const invoiceHeadroom = amountRub - Math.max(minInvoiceKopecks, 0);

  // Потолок по марже — ОПЦИОНАЛЬНЫЙ, в отличие от баллов. `capToMargin: false`
  // означает «номинал выдаём целиком и принимаем убыток».
  const marginCap = promo.capToMargin ? orderCommissionKopecks(order) : Number.POSITIVE_INFINITY;

  const discountKopecks = roundDownToWholeRubles(Math.min(nominal, invoiceHeadroom, marginCap));
  if (discountKopecks <= 0) return { ok: false, reason: 'no_headroom' };

  return {
    ok: true,
    plan: {
      discountKopecks,
      discountUsdCents: promo.discountUsdCents,
      capped: discountKopecks < roundDownToWholeRubles(nominal),
    },
  };
}
