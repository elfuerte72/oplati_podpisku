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

/**
 * Битую дату возвращаем вызывающему как `null`.
 *
 * ⚠️ Одного `try/catch` вокруг `toLocaleString` НЕ хватает: на `new Date('мусор')`
 * он не бросает, а отдаёт строку «Invalid Date» — и она уезжала бы в интерфейс
 * вместо срока (найдено тестом 2026-07-30).
 *
 * ⚠️ `Number.isNaN` тоже не полон: несуществующую календарную дату движок молча
 * НОРМАЛИЗУЕТ вместо отказа — `new Date('2026-02-30')` даёт 2 марта (проверено
 * пробой). Выдуманный срок на экране хуже сырой строки, поэтому результат
 * сверяется с исходными Y-M-D: разъехались — значит дата не наша.
 */
function parseIsoOrNull(iso: string): Date | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  // Сверяем только UTC-строки (все наши — из `toISOString`) и чистые даты.
  // Для строки со смещением («…T01:00:00+03:00») календарный день в UTC
  // законно отличается от написанного, и сверка отвергала бы валидную дату.
  const calendarPart = /^\d{4}-\d{2}-\d{2}/.exec(iso);
  const isUtc = iso.endsWith('Z') || !/[T ]/.test(iso);
  if (calendarPart && isUtc && date.toISOString().slice(0, 10) !== calendarPart[0]) return null;
  return date;
}

/**
 * ISO-дата → «до 14:30, 9 июня» (МСК). Для срока действия счёта/заказа.
 *
 * Года намеренно нет: счёт живёт час, фиксация цены — два, и год в такой
 * подписи только шумит. Для дат за пределами ближайших суток —
 * `formatDeadlineWithYear`.
 */
export function formatExpires(iso: string): string {
  const date = parseIsoOrNull(iso);
  if (!date) return iso;
  try {
    return date.toLocaleString('ru-RU', {
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

/**
 * ISO-дата → «22 декабря 2026, 23:59» (МСК). Для сроков, до которых месяцы:
 * «Действует до» карты и подобных.
 *
 * Год обязателен. Без него «Действует до 30 июня» у карты со сроком в 2030-м
 * читается как дата месячной давности — именно так и выглядел кабинет до
 * 2026-07-30, когда владелец заметил «карта действует до 30 июня, а сейчас
 * 30 июля».
 */
export function formatDeadlineWithYear(iso: string): string {
  const date = parseIsoOrNull(iso);
  if (!date) return iso;
  try {
    return date.toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: 'long',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Части даты по Москве — общие для коротких форматов вкладок Mini App. */
function moscowParts(iso: string, options: Intl.DateTimeFormatOptions): string | null {
  const date = parseIsoOrNull(iso);
  if (!date) return null;
  try {
    return date.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', ...options });
  } catch {
    return null;
  }
}

/**
 * ISO-дата → «20 марта 2027» (МСК), без времени. «Действует до» карты на
 * вкладке «Карта» (трек miniapp-tabs, тикет 06): срок в месяцах, и часы с
 * минутами рядом с ним только шумят. Год обязателен — см. `formatDeadlineWithYear`.
 */
export function formatDateWithYear(iso: string): string {
  const out = moscowParts(iso, { day: 'numeric', month: 'long', year: 'numeric' });
  return out ? out.replace(/\s*г\.$/, '') : iso;
}

/** ISO-дата → «23 сентября» (МСК) — дата заказа в списке «Заказы по этой карте». */
export function formatDayMonth(iso: string): string {
  return moscowParts(iso, { day: 'numeric', month: 'long' }) ?? iso;
}

/**
 * ISO-дата → «июля 2026» (МСК) — для строки «в Оплатишке с июля 2026» в профиле.
 * Родительный падеж берётся у формата «день месяц» (у одного месяца Intl отдаёт
 * именительный), день затем отрезается. Мусор — `null`: строку не рисуем.
 */
export function formatSinceMonth(iso: string): string | null {
  const dayMonth = moscowParts(iso, { day: 'numeric', month: 'long' });
  const year = moscowParts(iso, { year: 'numeric' });
  if (!dayMonth || !year) return null;
  const month = dayMonth.replace(/^\d+\s+/, '');
  return `${month} ${year.replace(/\s*г\.$/, '')}`;
}
