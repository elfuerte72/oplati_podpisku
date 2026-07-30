/**
 * Срок VPN-подписки.
 *
 * Режим по умолчанию — БЕЗ ОГРАНИЧЕНИЯ (решение владельца 2026-07-29): VPN
 * раздаётся бесплатно, пользуются им единицы, а месячный срок давал только
 * протухшую ссылку без предупреждения. Панель требует `expireAt` обязательно,
 * поэтому «без ограничения» выражается заведомо далёкой датой, а не пропуском
 * поля.
 *
 * Почему 2037, а не 2099: дата уходит во внешнюю систему и дальше — в чужой
 * код. Всё, что где-либо по пути держит unix-время в 32 битах, ломается
 * 2038-01-19. Одиннадцать лет — это «безлимит» для MVP при нулевом риске
 * налететь на Y2038 в панели или прокси.
 *
 * Дата ФИКСИРОВАННАЯ, а не «сейчас + N лет»: иначе каждая сверка видела бы
 * новое целевое значение и дёргала PATCH в панель на каждое нажатие кнопки.
 */
const UNLIMITED_EXPIRES_AT_MS = Date.UTC(2037, 11, 31, 23, 59, 59);

/**
 * Целевой срок подписки. `months <= 0` — без ограничения (дефолт), иначе
 * столько календарных месяцев от `from`.
 */
export function subscriptionExpiry(from: Date, months: number): Date {
  if (months <= 0) return new Date(UNLIMITED_EXPIRES_AT_MS);
  return addMonthsUtc(from, months);
}

/**
 * Срок «без ограничения»? Сравнение нестрогое: любая дата на уровне сентинела
 * или дальше — уже безлимит, и подтягивать её вверх незачем.
 */
export function isUnlimitedExpiry(date: Date): boolean {
  return date.getTime() >= UNLIMITED_EXPIRES_AT_MS;
}

/**
 * +N календарных месяцев по UTC с клампом на конец месяца (31 января →
 * 28/29 февраля, а не «3 марта» из-за перелива setUTCMonth).
 *
 * Кламп считается ОДИН раз, от исходного дня-якоря: 31 января + 3 месяца — это
 * 30 апреля. Наивная реализация «прибавить месяц N раз» дала бы 28 апреля,
 * потому что после первого клампа день 31 потерян навсегда, и каждый следующий
 * месяц отсчитывался бы уже от 28-го — клиент тихо недополучал бы дни.
 *
 * Чистая функция — тестируется без окружения.
 */
export function addMonthsUtc(from: Date, months: number): Date {
  const result = new Date(from.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, daysInTargetMonth));
  return result;
}

/** Частный случай `addMonthsUtc(from, 1)`. */
export function addOneMonthUtc(from: Date): Date {
  return addMonthsUtc(from, 1);
}
