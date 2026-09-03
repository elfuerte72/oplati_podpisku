import { CELL_TEXT } from './labels';

/**
 * Быстрый поиск панели: решения «что искать» и «как назвать найденное»,
 * отделённые от разметки и от запроса.
 *
 * ⚠️ Модуль читает клиентский компонент — ни Next, ни env, ни БД.
 */

/**
 * Короче двух символов не ищем. Один символ находит половину базы и греет её
 * на каждое нажатие клавиши, а прочитать такую выдачу всё равно нельзя.
 */
export const PANEL_SEARCH_MIN_LENGTH = 2;

/**
 * Сколько строк каждого рода показывать. Пять, а не двадцать: быстрый поиск
 * отвечает на «открой вот это», а не заменяет экран со всеми фильтрами —
 * длинную выдачу всё равно уточняют вводом.
 */
export const PANEL_SEARCH_LIMIT = 5;

/** Пауза после последнего нажатия клавиши. */
export const PANEL_SEARCH_DEBOUNCE_MS = 250;

export type PanelSearchOrderHit = {
  shortId: string;
  status: string;
  amountRubKopecks: number | null;
  serviceName: string | null;
  clientName: string | null;
};

export type PanelSearchClientHit = {
  id: string;
  displayName: string | null;
  telegramId: string | null;
  email: string | null;
};

export type PanelSearchResults = {
  orders: PanelSearchOrderHit[];
  clients: PanelSearchClientHit[];
};

/** Стоит ли идти в базу с этим вводом. */
export function isSearchable(query: string): boolean {
  return query.trim().length >= PANEL_SEARCH_MIN_LENGTH;
}

/**
 * Чем подписать клиента в выдаче.
 *
 * Имени у клиента может не быть (веб-сессия без Telegram), и строка выдачи
 * обязана оставаться нажимаемой: пустая строка — это невидимая ссылка.
 * Порядок опознания — имя, потом telegram, потом почта: имя человек узнаёт,
 * идентификатор — сверяет.
 */
export function clientHitTitle(client: PanelSearchClientHit): string {
  return client.displayName?.trim() || client.telegramId || client.email || CELL_TEXT.clientNoName;
}

/**
 * Строка под именем: чем этот клиент отличается от соседнего в выдаче.
 * Показываем только то, что НЕ ушло в заголовок, иначе строка повторяет себя.
 */
export function clientHitHint(client: PanelSearchClientHit): string {
  const title = clientHitTitle(client);
  const parts = [client.telegramId, client.email].filter(
    (part): part is string => Boolean(part) && part !== title,
  );
  return parts.length > 0 ? parts.join(' · ') : CELL_TEXT.noTelegramShort;
}
