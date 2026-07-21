/**
 * Срок VPN-подписки: «ровно месяц» = +1 календарный месяц по UTC с клампом
 * на конец месяца (31 января → 28/29 февраля, а не «3 марта» из-за перелива
 * setUTCMonth). Чистая функция — тестируется без окружения.
 */
export function addOneMonthUtc(from: Date): Date {
  const result = new Date(from.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, daysInTargetMonth));
  return result;
}
