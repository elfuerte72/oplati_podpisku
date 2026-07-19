/**
 * Разбор суммы в долларах из текстового сообщения — для кнопочного флоу
 * Telegram (custom-amount сервисы вроде Airbnb: бот просит сумму, следующий
 * текст трактуется как неё). Чистый модуль без серверных зависимостей, чтобы
 * логику gate'а можно было покрыть юнит-тестами в изоляции.
 *
 * Границы те же, что на сайте (StartScreen) и в `proposeOrder`: $1–$500 для
 * обычных сервисов, до $5000 для сервисов-пополнений (Airbnb/Booking/Steam).
 */

export const MIN_AMOUNT_USD = 1;
export const MAX_AMOUNT_USD = 500;

// Сервисы-пополнения с крупной индивидуальной ценой (Airbnb/Booking/Steam/App Store)
// допускают суммы до HIGH_VALUE_MAX_AMOUNT_USD. Зеркалит серверный
// HIGH_VALUE_SERVICE_SLUGS из propose-order.ts и фронтовый в StartScreen.tsx —
// держать синхронно.
export const HIGH_VALUE_SLUGS: ReadonlySet<string> = new Set([
  'airbnb',
  'booking',
  'steam',
  'apple-app-store',
]);
export const HIGH_VALUE_MAX_AMOUNT_USD = 5000;

export function maxAmountUsdFor(slug: string): number {
  return HIGH_VALUE_SLUGS.has(slug) ? HIGH_VALUE_MAX_AMOUNT_USD : MAX_AMOUNT_USD;
}

export type AmountParse =
  | { kind: 'ok'; usdCents: number }
  | { kind: 'invalid' }
  | { kind: 'not_amount' };

/**
 * Нормализация запятых (M-5 аудита): «1,000» — это разделитель тысяч, а не $1.
 * Правила:
 *   - запятые, за каждой из которых ровно 3 цифры (и десятичная точка, если
 *     есть, стоит после них) — разделители тысяч, убираем: `1,000` → 1000,
 *     `1,000.50` → 1000.50;
 *   - одна запятая с 1–2 цифрами после и без точки — десятичная: `1,5` → 1.5,
 *     `19,99` → 19.99. Исключение — нулевая дробь (`1,00`): неотличима от
 *     обрубленных тысяч (`1,00[0]`), безопаснее переспросить → null;
 *   - всё остальное (европейский `1.000,50`, `1,0000` и т.п.) — двусмысленно
 *     → null (caller вернёт `invalid`, бот переспросит).
 */
function normalizeSeparators(cleaned: string): string | null {
  if (!cleaned.includes(',')) return cleaned;
  // Все запятые — разделители тысяч: за каждой ровно 3 цифры, точка (если есть)
  // одна и после последней группы.
  if (/^[^.,]+(?:,\d{3})+(?:\.\d+)?$/.test(cleaned)) {
    return cleaned.replace(/,/g, '');
  }
  // Одна запятая как десятичная: 1–2 цифры дроби, точки нет.
  const decimal = /^([^.,]+),(\d{1,2})$/.exec(cleaned);
  if (decimal && decimal[2] !== '00' && decimal[2] !== '0') {
    return `${decimal[1]}.${decimal[2]}`;
  }
  return null;
}

/**
 * Трёхпутёвый разбор:
 *   - нет цифр вовсе → `not_amount` (смена намерения — отдаём агенту);
 *   - похоже на сумму, но не парсится/вне $1–500 → `invalid` (переспросить);
 *   - валидное число в диапазоне → `ok` с округлением до центов.
 *
 * Строгий разбор всей строки (а не «вытащить первое число») — чтобы «оплати 5
 * подписок» не превратилось в заказ на $5.
 */
export function parseCustomAmountUsd(text: string, slug: string): AmountParse {
  if (!/\d/.test(text)) return { kind: 'not_amount' };
  const normalized = normalizeSeparators(text.trim().replace(/[$\s]/g, ''));
  if (normalized === null) return { kind: 'invalid' };
  const usd = Number(normalized);
  const maxUsd = maxAmountUsdFor(slug);
  if (!Number.isFinite(usd) || usd < MIN_AMOUNT_USD || usd > maxUsd) {
    return { kind: 'invalid' };
  }
  return { kind: 'ok', usdCents: Math.round(usd * 100) };
}
