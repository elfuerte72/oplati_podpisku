/**
 * Шкалы графиков панели — чистая арифметика без React, чтобы её проверял тест,
 * а компоненты только рисовали.
 *
 * Верх оси — «круглое» число (1 / 2 / 2,5 / 5 × 10ⁿ), а не максимум ряда: ось с
 * делением «3 417» читается медленнее, чем «5 000», а столбец при этом не
 * упирается в потолок. Нулевой ряд даёт верх 1, чтобы деление на ноль не
 * появилось даже там, где страница забыла проверить пустоту.
 */

const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;

/** Ближайшее сверху «круглое» число; для нуля и мусора — 1. */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of NICE_STEPS) {
    const candidate = step * magnitude;
    if (candidate >= value - 1e-9) return candidate;
  }
  return 10 * magnitude;
}

/** Деления оси: ноль, середина, верх. Три — достаточно, чтобы читать масштаб. */
export function axisTicks(max: number): number[] {
  const top = niceCeil(max);
  return [0, top / 2, top];
}

/** Подпись дня для оси: `2026-03-01` → `01.03`. Год ось не несёт — он в периоде. */
export function shortDay(day: string): string {
  const [, month, date] = day.split('-');
  return month && date ? `${date}.${month}` : day;
}

/**
 * Какие дни подписывать под осью: первый, последний и середина, чтобы подписи
 * не налезали друг на друга при 90 точках. Возвращает индексы.
 */
export function labelledIndexes(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  if (count === 2) return [0, 1];
  return [0, Math.floor((count - 1) / 2), count - 1];
}
