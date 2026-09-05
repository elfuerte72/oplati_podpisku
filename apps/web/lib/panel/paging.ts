import { z } from 'zod';

/**
 * Страница списка панели — одна модель на все экраны.
 *
 * До варианта A шесть экранов писали «показаны не все» и не давали НИКАКОГО
 * способа увидеть остальное: список обрывался на потолке выборки. Модель взята
 * существующая — страницы заказов, — а не «показать ещё» из отчёта аудита:
 * механика смещения и ключ адреса в репозитории уже были, а вторая модель
 * стала бы третьим разнобоем вместо лечения второго.
 *
 * Страница живёт В АДРЕСЕ (`?page=N`): ссылку на неё можно переслать коллеге.
 * Ключ не меняется никогда — пересланная ссылка обязана значить то же самое.
 */

export const PAGE_PARAM = 'page';

/**
 * Потолок номера страницы. Тот же, что у заказов: без него `?page=1e9`
 * уезжает в `OFFSET` и заставляет базу отматывать миллиард строк в том же
 * процессе, который принимает вебхуки.
 */
const pageSchema = z.coerce.number().int().min(1).max(1000);

/**
 * Номер страницы из адреса. Мусор — первая страница, а не ошибка: настройка
 * вида не должна ронять экран. Экран заказов при этом ГОВОРИТ о непонятом
 * параметре вслух (`parseOrdersQuery`), потому что там их много и молчание
 * означало бы «ссылка коллеге показывает не то».
 */
export function parsePanelPage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return 1;
  const parsed = pageSchema.safeParse(raw);
  return parsed.success ? parsed.data : 1;
}

/** Смещение выборки для страницы. Первая страница — ноль. */
export function panelOffset(page: number, rows: number): number {
  return (page - 1) * rows;
}

/**
 * Адрес страницы N при сохранении остальных параметров экрана.
 *
 * Собирается из готовых пар, а не из `URLSearchParams` запроса: у страниц
 * панели свои наборы ключей, и протаскивание неразобранного адреса означало бы,
 * что мусор из него переезжает по ссылкам дальше.
 */
export function panelPageHref(
  path: string,
  params: Readonly<Record<string, string | number | undefined>>,
  page: number,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    query.set(key, String(value));
  }
  // Первая страница ключа не несёт: адрес без `?page=1` короче и совпадает с
  // тем, по которому в раздел приходят из меню.
  if (page > 1) query.set(PAGE_PARAM, String(page));
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}
