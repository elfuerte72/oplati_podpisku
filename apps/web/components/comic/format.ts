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
  const usd = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: Number.isInteger(usd) ? 0 : 2,
  }).format(usd);
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
