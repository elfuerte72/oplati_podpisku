/**
 * Форматирование для партнёрского кабинета. База — USD-центы (integer) и ставки
 * в bps; форматируем на отображении (как `formatRub` для рублей).
 */

// Единая реализация живёт в comic/format (L-13) — здесь реэкспорт, чтобы не
// менять импорты партнёрских компонентов.
export { formatUsd } from '../comic/format';

/** bps → `6%` / `2.5%`. */
export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** ISO → «28 июн, 14:32» (МСК). */
export function formatLedgerDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** `YYYY-MM` → короткий месяц «июн» для оси графика. */
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export function formatMonthShort(key: string): string {
  const m = Number(key.slice(5, 7));
  return MONTHS_SHORT[m - 1] ?? key;
}
