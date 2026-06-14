/**
 * Разбор суммы в долларах из текстового сообщения — для кнопочного флоу
 * Telegram (custom-amount сервисы вроде Airbnb: бот просит сумму, следующий
 * текст трактуется как неё). Чистый модуль без серверных зависимостей, чтобы
 * логику gate'а можно было покрыть юнит-тестами в изоляции.
 *
 * Границы те же, что на сайте (StartScreen) и в `proposeOrder` ($1–$500).
 */

export const MIN_AMOUNT_USD = 1;
export const MAX_AMOUNT_USD = 500;

export type AmountParse =
  | { kind: 'ok'; usdCents: number }
  | { kind: 'invalid' }
  | { kind: 'not_amount' };

/**
 * Трёхпутёвый разбор:
 *   - нет цифр вовсе → `not_amount` (смена намерения — отдаём агенту);
 *   - похоже на сумму, но не парсится/вне $1–500 → `invalid` (переспросить);
 *   - валидное число в диапазоне → `ok` с округлением до центов.
 *
 * Строгий разбор всей строки (а не «вытащить первое число») — чтобы «оплати 5
 * подписок» не превратилось в заказ на $5.
 */
export function parseCustomAmountUsd(text: string): AmountParse {
  if (!/\d/.test(text)) return { kind: 'not_amount' };
  const cleaned = text.trim().replace(/[$\s]/g, '').replace(',', '.');
  const usd = Number(cleaned);
  if (!Number.isFinite(usd) || usd < MIN_AMOUNT_USD || usd > MAX_AMOUNT_USD) {
    return { kind: 'invalid' };
  }
  return { kind: 'ok', usdCents: Math.round(usd * 100) };
}
