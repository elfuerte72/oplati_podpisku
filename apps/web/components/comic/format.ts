/**
 * Форматирование денег: суммы в БД хранятся в копейках (integer),
 * на отображении конвертируем в рубли.
 */
export function formatRub(kopecks: number): string {
  const rub = kopecks / 100;
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    minimumFractionDigits: 0,
    maximumFractionDigits: Number.isInteger(rub) ? 0 : 2,
  }).format(rub);
}

/**
 * Форматирование оригинальной цены подписки в долларах (USD-центы → `$9.99`).
 * Показываем клиенту как «сколько ввести на сайте сервиса»; рублёвая
 * `formatRub`-сумма остаётся «чеком» (сколько списываем у нас). Центы —
 * только когда сумма не целая ($10, но $9.99).
 */
export function formatUsd(cents: number): string {
  // Единственная реализация (L-13: дубль из partner/format-usd.ts сведён сюда).
  // Целые — без центов ($1,800), дробные — всегда 2 знака ($0.96), знак минуса
  // сохраняется для отрицательных сумм (история выводов партнёрки).
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents) / 100;
  const dec = Number.isInteger(abs) ? 0 : 2;
  return `${sign}${new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: dec,
    maximumFractionDigits: 2,
  }).format(abs)}`;
}

/** ISO-дата → «до 14:30, 9 июня» (МСК). Для срока действия счёта/заказа. */
export function formatExpires(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: 'long',
    });
  } catch {
    return iso;
  }
}
