/**
 * Комиссия платёжной системы, которую платит ПОКУПАТЕЛЬ поверх нашего счёта.
 *
 * Чистый модуль без серверных зависимостей: его импортируют и клиентские
 * компоненты (процент приходит с сервера в API-ответах), и тексты бота. Смысл —
 * одна формулировка на весь продукт: разъехавшиеся тексты про деньги хуже, чем
 * их отсутствие.
 *
 * Источник процента — `buyerFeePercentFor()` в `./gateway.ts` (зависит от того,
 * какой шлюз принимает деньги). Мы эту надбавку НЕ считаем и НЕ получаем: её
 * начисляет провайдер на своей странице, нам приходит ровно сумма счёта.
 * Поэтому суммы ниже — оценочные («≈»), точное округление на стороне провайдера
 * нам неизвестно.
 */

/** Сумма, которую увидит плательщик на странице шлюза (оценка, в копейках). */
export function amountWithBuyerFeeKopecks(amountKopecks: number, feePercent: number): number {
  if (feePercent <= 0) return amountKopecks;
  return Math.round(amountKopecks * (1 + feePercent / 100));
}

/**
 * Предупреждение для экранов, где показана сумма заказа: клиент должен узнать о
 * надбавке ДО перехода на страницу оплаты, а не на ней.
 * `null` — комиссии нет (текущий шлюз её не добавляет), блок не рендерится.
 */
export function buyerFeeNote(feePercent: number): string | null {
  if (feePercent <= 0) return null;
  return `При оплате добавится комиссия платёжной системы — ${formatPercent(feePercent)}.`;
}

/** Короткая подпись под кнопкой оплаты: «≈ 2 601 ₽ на странице оплаты (+6%)». */
export function buyerFeeAmountNote(
  amountKopecks: number,
  feePercent: number,
  formatRub: (kopecks: number) => string,
): string | null {
  if (feePercent <= 0) return null;
  const total = amountWithBuyerFeeKopecks(amountKopecks, feePercent);
  return `На странице оплаты — ≈ ${formatRub(total)}: комиссия платёжной системы ${formatPercent(feePercent)}.`;
}

/** «6%» / «6.5%» — без хвостовых нулей, чтобы не писать «6.00%». */
function formatPercent(percent: number): string {
  return `${Number(percent.toFixed(2))}%`;
}
