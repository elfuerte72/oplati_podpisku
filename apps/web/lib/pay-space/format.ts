/**
 * Конвертеры на границе app.pay.space.
 *
 * PaySpace оперирует строками-долларами ("10.00"), наш внутренний инвариант —
 * деньги integer в минимальных единицах (USD-центы). Перевод — только здесь.
 */

/** USD-центы (integer) → строка-доллары "X.XX" (без потери точности на fp). */
export function usdCentsToDollarString(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`usdCentsToDollarString: ожидался integer, получено ${cents}`);
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

/** Строка-доллары ("10" / "10.00" / "10.5") → USD-центы (integer). */
export function dollarStringToUsdCents(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`dollarStringToUsdCents: невалидная сумма "${value}"`);
  }
  return Math.round(n * 100);
}

/**
 * Маска PAN для БД/логов: первые 6 + последние 4, середина — звёздочки.
 * Полный PAN провайдер маской не отдаёт — считаем сами. Короткие/нечисловые
 * значения маскируем целиком, чтобы не утечь PAN.
 */
export function maskPan(pan: string): string {
  const digits = pan.replace(/\D/g, '');
  if (digits.length < 10) return '*'.repeat(Math.max(digits.length, 4));
  return `${digits.slice(0, 6)}${'*'.repeat(digits.length - 10)}${digits.slice(-4)}`;
}

/** "YYYY-MM-DD" (формат exp_date в ответе create) → { expMonth, expYear }. */
export function parseExpDateYmd(value: string): { expMonth: number; expYear: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new Error(`parseExpDateYmd: ожидался YYYY-MM-DD, получено "${value}"`);
  const [, yyyy, mm] = m;
  if (!yyyy || !mm) throw new Error(`parseExpDateYmd: не разобрана дата "${value}"`);
  return { expYear: Number(yyyy), expMonth: Number(mm) };
}
