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
  /**
   * Сколько это в USD-центах — ФАКТИЧЕСКИ выданная скидка, а не номинал кода.
   *
   * ⚠️ Разница принципиальна там, где скидку урезали (`capped`): номинал кода
   * $5, а выдали 300 ₽ ≈ $3.4. Именно это число вычитается из комиссии заказа
   * в `accrue.ts` — вычитание номинала занижало бы базу реферального начисления
   * на разницу, и реферер молча недополучал бы процент из маржи, которая на
   * самом деле осталась (находка ревью). Номинал кода никуда не теряется — он
   * лежит в `promo_codes.discount_usd_cents`, а строка применения ссылается на
   * код по `promo_code_id`.
   */
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
  //
  // ⚠️ Нижняя граница — НЕ только минимум шлюза. `FREEKASSA_MIN_AMOUNT_RUB=0`
  // задокументирован как аварийный выключатель гейта, и тогда `minInvoice`
  // перестаёт что-либо ограничивать: код с номиналом больше цены заказа дал бы
  // нулевой или отрицательный счёт прямо в API шлюза (находка ревью). Поэтому
  // счёту всегда оставляем хотя бы рубль — своей проверки на это нигде ниже
  // нет, а у баллов такого риска не было: их потолок — комиссия заказа.
  const floorKopecks = Math.max(minInvoiceKopecks, 100);
  const invoiceHeadroom = amountRub - floorKopecks;

  // Потолок по марже — ОПЦИОНАЛЬНЫЙ, в отличие от баллов. `capToMargin: false`
  // означает «номинал выдаём целиком и принимаем убыток».
  const marginCap = promo.capToMargin ? orderCommissionKopecks(order) : Number.POSITIVE_INFINITY;

  const discountKopecks = roundDownToWholeRubles(Math.min(nominal, invoiceHeadroom, marginCap));
  if (discountKopecks <= 0) return { ok: false, reason: 'no_headroom' };

  const capped = discountKopecks < roundDownToWholeRubles(nominal);
  return {
    ok: true,
    plan: {
      discountKopecks,
      // Не урезали — номинал как есть (без обратной конверсии и её округления);
      // урезали — пересчитываем ФАКТ по курсу заказа.
      discountUsdCents: capped
        ? kopecksToUsdCents(discountKopecks, rateKopecks)
        : promo.discountUsdCents,
      capped,
    },
  };
}

/**
 * Обратная конверсия «рубли скидки → USD-центы» по курсу ЗАКАЗА.
 *
 * Нужна ровно в одном месте — когда скидку урезали и надо знать, сколько маржи
 * она на самом деле съела. Прямая конверсия (`promoNominalKopecks`) округляет
 * вниз, обратная — ВВЕРХ: обе в нашу пользу. Здесь «в нашу пользу» значит «не
 * занизить потраченную маржу», иначе рефереру начислится процент из денег,
 * которых уже нет.
 *
 * Минимум 1 цент: скидка существует (проверено выше), и ноль означал бы
 * «промокода не было».
 */
function kopecksToUsdCents(discountKopecks: number, rateKopecks: number): number {
  if (rateKopecks <= 0) return 0;
  return Math.max(1, Math.ceil((discountKopecks * RATE_SCALE) / rateKopecks));
}
