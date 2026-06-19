/**
 * Конвертеры на границе app.pay.space.
 *
 * PaySpace оперирует суммами то строкой ("18.43"), то числом (1.0 — `card.balance`
 * в create), а наш внутренний инвариант — деньги integer в минимальных единицах
 * (USD-центы). Перевод — только здесь.
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

/** Сумма из ответа PaySpace (строка "10.5" или число 1.0) → USD-центы (integer). */
export function dollarStringToUsdCents(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(value);
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

/**
 * Срок действия карты → { expMonth, expYear }. Поддерживает оба формата, что
 * встречаются у PaySpace: `MM/YY` (реальный ответ create/info) и `YYYY-MM-DD`
 * (как в доке). Зафиксировано живым вызовом 2026-06-18: create вернул "06/27".
 */
export function parseExpDate(value: string): { expMonth: number; expYear: number } {
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (ymd) {
    const yyyy = ymd[1];
    const mm = ymd[2];
    if (yyyy && mm) return { expYear: Number(yyyy), expMonth: Number(mm) };
  }
  const my = /^(\d{2})\/(\d{2})$/.exec(value);
  if (my) {
    const mm = my[1];
    const yy = my[2];
    if (mm && yy) return { expMonth: Number(mm), expYear: 2000 + Number(yy) };
  }
  throw new Error(`parseExpDate: неизвестный формат срока "${value}"`);
}
