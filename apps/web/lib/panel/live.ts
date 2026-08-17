/**
 * Условия живого обновления панели (спека §3.4). Чистая функция, потому что это
 * не косметика: обновление посреди действия или набора текста стирает работу
 * менеджера, а тихий рефреш в скрытой вкладке дёргает процесс, который в тот же
 * момент принимает вебхуки Freekassa и Telegram.
 */

export const PANEL_REFRESH_MS = 25_000;

export type LiveRefreshState = {
  /** Вкладка на экране? */
  visible: boolean;
  /** Идёт операция панели (кнопка нажата, ответ не пришёл). */
  busy: boolean;
  /** Фокус в поле ввода — человек печатает. */
  typing: boolean;
};

export function canRefreshNow(state: LiveRefreshState): boolean {
  return state.visible && !state.busy && !state.typing;
}
