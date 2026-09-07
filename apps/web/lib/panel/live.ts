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

/** Куда клиент ходит за живыми событиями (SSE, `app/api/panel/events`). */
export const PANEL_EVENTS_PATH = '/api/panel/events';

/**
 * Задержка перерисовки после живого события. Не ноль: событие приходит по
 * факту ЗАПИСИ в базу, а не коммита транзакции, и мгновенный рефреш читал бы
 * ещё старое состояние; заодно одно действие (оплата = переход заказа + claim
 * платежа) склеивается в одну перерисовку и на клиенте.
 */
export const PANEL_EVENT_REFRESH_DELAY_MS = 400;

export type RefreshScheduler = {
  /** Пришло живое событие — перерисовать (с задержкой и склейкой). */
  onEvent: () => void;
  /** Вкладка снова видна — добрать перерисовку, отложенную, пока было нельзя. */
  onVisible: () => void;
  dispose: () => void;
};

/**
 * Планировщик перерисовки по живому событию. Чистый: сам решает только «когда»,
 * а «можно ли» спрашивает у `canRefresh` (те же условия, что у опроса —
 * `canRefreshNow`). Если в момент срабатывания нельзя (вкладка скрыта, идёт
 * операция, печатают), перерисовка ОТКЛАДЫВАЕТСЯ до возвращения вкладки, а не
 * теряется: событие уже сказало, что данные устарели.
 */
export function createRefreshScheduler(opts: {
  refresh: () => void;
  canRefresh: () => boolean;
  delayMs?: number;
}): RefreshScheduler {
  const delayMs = opts.delayMs ?? PANEL_EVENT_REFRESH_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const fire = () => {
    timer = null;
    if (opts.canRefresh()) {
      pending = false;
      opts.refresh();
    } else {
      pending = true;
    }
  };

  return {
    onEvent() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, delayMs);
    },
    onVisible() {
      if (!pending || !opts.canRefresh()) return;
      pending = false;
      opts.refresh();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = false;
    },
  };
}
