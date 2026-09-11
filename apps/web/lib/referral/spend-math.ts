import { roundDownToWholeRubles } from '../pricing.ts';
import { serverEnv } from '../env.server.ts';

/**
 * Математика скидки за реферальные баллы (трек referral-balance-spend, §7 спеки).
 *
 * Чистые функции без БД и без сети: их зовут ДВЕ точки — витрина экрана заказа
 * в Mini App (сколько предложить списать) и `payments/create` (сколько списать
 * на самом деле). Обе обязаны звать одну функцию — по образцу
 * `roundUpToWholeRubles`, у которого расхождение двух точек расчёта означало бы
 * одну цену в каталоге и другую в заказе. Здесь цена расхождения выше: клиент
 * увидел бы одну скидку, а счёт ушёл бы на другую сумму.
 *
 * Курс берётся ТОЛЬКО из снимка заказа (`usdt_rub_rate_kopecks`), никогда из
 * живого Rapira: клиент видит скидку в тех же рублях, в которых посчитана цена.
 *
 * Ключевое ограничение экономики: **баллы платятся из маржи заказа, никогда из
 * карточного фонда**. Потолок скидки — комиссия этого заказа, поэтому рублей
 * всегда хватает на выпуск карты, а денежный путь (счёт → вебхук → `paid` →
 * `issue-card`) остаётся нетронутым.
 */

/** Снимок заказа, из которого считается скидка. Ровно четыре поля `orders`. */
export type BonusSpendOrder = {
  /** Полная цена заказа, RUB-копейки (`orders.amount_rub`). */
  amountRub: number | null;
  /** База в USD-центах (`orders.original_amount`). */
  originalAmount: number | null;
  /**
   * Валюта базы (`orders.original_currency`). NULL считаем USD — так пишут все
   * нынешние пути.
   */
  originalCurrency?: string | null;
  /** Снимок надбавки за выпуск карты, RUB-копейки; NULL — заказ до фичи. */
  cardIssueFeeKopecks: number | null;
  /** Курс USDT→RUB × 10000 (`orders.usdt_rub_rate_kopecks`). */
  usdtRubRateKopecks: number | null;
};

export type BonusSpendPlan = {
  /** На сколько уменьшится счёт, RUB-копейки. Всегда кратно рублю и > 0. */
  discountKopecks: number;
  /** Сколько центов баланса за это списывается. Всегда > 0 и ≤ баланса. */
  spendUsdCents: number;
};

/** Курс хранится как `rate × 10000` (фиксированная точка, 4 знака). */
const RATE_SCALE = 10_000;

/**
 * Комиссия заказа в копейках — она же ПОТОЛОК скидки.
 *
 * `amount_rub − card_issue_fee_kopecks − round(original_amount × rate)`: из
 * полной цены вычитаем надбавку за выпуск карты (это не маржа, а прямой расход
 * у PaySpace) и себестоимость подписки по курсу заказа. Остаток — наша маржа,
 * из неё и платятся баллы.
 *
 * Формула повторяет `propose_order` в обратную сторону, а не пересчитывает
 * комиссию по проценту: процент округляется вверх до целого рубля при фиксации
 * цены, и разница уходит именно в комиссию. Считать «по проценту» значило бы
 * систематически занижать потолок на разницу округления.
 *
 * Неполный снимок (заказ без курса или без USD-базы) → 0: скидки не будет.
 * Отрицательный результат (сломанный снимок) тоже 0 — потолок не бывает
 * отрицательным. Заказ не в USD → тоже 0 (см. guard внутри).
 */
export function orderCommissionKopecks(order: BonusSpendOrder): number {
  const { amountRub, originalAmount, usdtRubRateKopecks, cardIssueFeeKopecks } = order;
  if (!amountRub || amountRub <= 0) return 0;
  if (!originalAmount || originalAmount <= 0) return 0;
  if (!usdtRubRateKopecks || usdtRubRateKopecks <= 0) return 0;
  // Guard от дрейфа валют — тот же, что стоит в `accrue.ts`: `original_amount`
  // трактуется как USD-центы, и заказ в другой валюте дал бы неверный потолок,
  // то есть скидку из чужой маржи. Сегодня каталог всегда USD, проверка
  // защитная. NULL считаем USD (так пишут все нынешние пути).
  if ((order.originalCurrency ?? 'USD') !== 'USD') return 0;
  const subtotalKopecks = Math.round((originalAmount * usdtRubRateKopecks) / RATE_SCALE);
  const commission = amountRub - (cardIssueFeeKopecks ?? 0) - subtotalKopecks;
  return commission > 0 ? commission : 0;
}

/**
 * Ставка премии за трату баллов, % поверх паритета (дефолт 0 = $1 гасит $1).
 *
 * ЕДИНСТВЕННОЕ место, где эта величина читается: премия должна включаться
 * цифрой в env, а не второй формулой в коде (решение Q2).
 */
export function referralSpendBonusPercent(): number {
  return serverEnv.REFERRAL_SPEND_RATE_BONUS_PERCENT;
}

/** Минимум одного списания в центах (`REFERRAL_SPEND_MIN_USD_CENTS`). */
export function referralSpendMinUsdCents(): number {
  return serverEnv.REFERRAL_SPEND_MIN_USD_CENTS;
}

/**
 * Во сколько RUB-копеек превращаются `usdCents` баллов по курсу заказа.
 *
 * ЕДИНСТВЕННАЯ точка конверсии «баллы → рубли» — и прямая (сколько дать
 * скидки), и обратная (`planBonusSpend` делит на неё же). Считаем в целых:
 * `usdCents × rateKopecks × (100 + premium)` при делении на `10000 × 100`
 * помещается в safe integer с большим запасом, а произведение float дало бы
 * хвост вида `28673.999999999996` — то есть рубль скидки то туда, то сюда.
 *
 * Округление ВНИЗ: величина, которую мы отдаём клиенту.
 */
export function bonusValueKopecks(
  usdCents: number,
  rateKopecks: number,
  bonusPercent: number = referralSpendBonusPercent(),
): number {
  if (!Number.isFinite(usdCents) || usdCents <= 0) return 0;
  if (!Number.isFinite(rateKopecks) || rateKopecks <= 0) return 0;
  const premium = Number.isFinite(bonusPercent) && bonusPercent > 0 ? bonusPercent : 0;
  return Math.floor((usdCents * rateKopecks * (100 + premium)) / (RATE_SCALE * 100));
}

/**
 * Эффективный потолок скидки для этого заказа: комиссия, но не настолько, чтобы
 * счёт упал ниже минимума шлюза. Округлён вниз до рубля.
 *
 * Нужен экрану заказа отдельно от плана: клиенту с балансом больше потолка
 * объясняем, ПОЧЕМУ списалось меньше, и число берём из расчёта, а не из текста.
 *
 * ⚠️ `promoDiscountKopecks` — скидка, которую УЖЕ дал промокод по этому заказу
 * (трек promo-codes). Порядок скидок фиксирован: **промокод первый, баллы
 * вторые**, и живёт это правило здесь, в одном месте. Вычитается дважды и
 * по-разному:
 *
 *  - из комиссии, потому что баллы платятся из МАРЖИ, а промокод её уже
 *    потратил. Без этого покупатель гасил бы баллами маржу, которой нет, и
 *    заказ уходил бы в минус вторым путём;
 *  - из headroom до минимума счёта, потому что счёт уже уменьшен промокодом, и
 *    считать запас от полной цены значило бы разрешить баллам опустить счёт
 *    ниже минимума шлюза.
 *
 * Промокод с `capToMargin: false` может съесть БОЛЬШЕ всей комиссии — тогда
 * остаток маржи ноль, и баллы по такому заказу не предлагаются вовсе. Это
 * правильный ответ, а не дефект: платить скидку ещё и баллами было бы третьим
 * слоем убытка на одном заказе.
 */
export function bonusSpendCapKopecks(input: {
  order: BonusSpendOrder;
  minInvoiceKopecks: number;
  promoDiscountKopecks?: number;
}): number {
  const { order, minInvoiceKopecks, promoDiscountKopecks = 0 } = input;
  const promo = Math.max(promoDiscountKopecks, 0);
  const commission = orderCommissionKopecks(order) - promo;
  if (commission <= 0) return 0;
  const amountRub = order.amountRub ?? 0;
  // Физический предел провайдера: остаток счёта обязан быть не меньше его
  // минимума, иначе счёт просто не выставится. Счёт уже уменьшен промокодом.
  const invoiceHeadroom = amountRub - promo - Math.max(minInvoiceKopecks, 0);
  return roundDownToWholeRubles(Math.min(commission, invoiceHeadroom));
}

/**
 * Сколько списать под этот заказ. `null` — предлагать нечего.
 *
 * Порядок ровно такой:
 *  1. потолок = комиссия заказа, усечённая минимумом шлюза, вниз до рубля;
 *  2. ценность баланса по курсу заказа (с премией, если включена);
 *  3. скидка = меньшее из двух, вниз до рубля;
 *  4. списываемые центы = `ceil(скидка / ценность одного цента)` — округление
 *     ВВЕРХ, в нашу пользу, — но не больше баланса;
 *  5. списание ниже минимума (`$1`) не предлагается вовсе: «сэкономили 12 ₽»
 *     не стоит ни клика клиента, ни строки в его балансе.
 *
 * `promoDiscountKopecks` — скидка, уже данная промокодом по этому заказу
 * (порядок «промокод первый, баллы вторые»); вся арифметика вычета живёт в
 * `bonusSpendCapKopecks`.
 */
export function planBonusSpend(input: {
  order: BonusSpendOrder;
  balanceUsdCents: number;
  /** Минимальная сумма счёта у активного шлюза, RUB-копейки (0 — минимума нет). */
  minInvoiceKopecks: number;
  /** Скидка промокода по этому заказу, RUB-копейки (0 — промокода нет). */
  promoDiscountKopecks?: number;
  minSpendUsdCents?: number;
  bonusPercent?: number;
}): BonusSpendPlan | null {
  const {
    order,
    balanceUsdCents,
    minInvoiceKopecks,
    promoDiscountKopecks = 0,
    minSpendUsdCents = referralSpendMinUsdCents(),
    bonusPercent = referralSpendBonusPercent(),
  } = input;

  const rateKopecks = order.usdtRubRateKopecks ?? 0;
  if (rateKopecks <= 0) return null;
  if (!Number.isFinite(balanceUsdCents) || balanceUsdCents <= 0) return null;

  const cap = bonusSpendCapKopecks({ order, minInvoiceKopecks, promoDiscountKopecks });
  if (cap <= 0) return null;

  const balanceValue = bonusValueKopecks(balanceUsdCents, rateKopecks, bonusPercent);
  const discountKopecks = roundDownToWholeRubles(Math.min(cap, balanceValue));
  if (discountKopecks <= 0) return null;

  // Обратная конверсия той же формулой, что и прямая: цена одного цента —
  // `rateKopecks × (100 + premium) / (10000 × 100)`, и делим на неё в целых,
  // чтобы не ловить хвост float на границе рубля.
  const premium = Number.isFinite(bonusPercent) && bonusPercent > 0 ? bonusPercent : 0;
  const spendRaw = Math.ceil(
    (discountKopecks * RATE_SCALE * 100) / (rateKopecks * (100 + premium)),
  );
  const spendUsdCents = Math.min(spendRaw, balanceUsdCents);
  if (spendUsdCents <= 0) return null;
  if (spendUsdCents < minSpendUsdCents) return null;

  return { discountKopecks, spendUsdCents };
}
