/**
 * Числа из `db.execute` приходят строками (`bigint`/`numeric` postgres-js не
 * приводит) — приводим в одном месте. Одна копия на отчёты, аналитику панели и
 * уведомление об оплате: разошедшиеся копии дали бы разные числа по одной
 * колонке в двух сообщениях одной группы.
 */
export function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
