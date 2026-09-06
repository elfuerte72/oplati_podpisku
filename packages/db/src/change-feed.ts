/**
 * Лента изменений таблиц — репозитории сообщают «эта таблица изменилась»,
 * приложение слушает (живое обновление панели через SSE, трек panel-live).
 *
 * Здесь нет ни данных, ни идентификаторов — только имя таблицы: слушатель сам
 * решает, что перечитать. Уведомление — ФАКТ записи, а не гарантия коммита:
 * репозиторий может работать внутри чужой транзакции и не знает, когда она
 * закоммитится. Потребитель обязан это учитывать (панель перечитывает с
 * задержкой и держит опрос как страховку).
 *
 * Слушатели живут в `globalThis`, а не в модуле: при HMR модуль может быть
 * загружен дважды, и подписка одного экземпляра не видела бы записи другого.
 *
 * Упавший слушатель не роняет запись в базу — его ошибка уходит в `onError`
 * подписки, а остальные слушатели получают уведомление как ни в чём не бывало.
 */

export const DB_CHANGE_TABLES = [
  'orders',
  'payments',
  'conversations',
  'messages',
  'client_feedback',
] as const;

export type DbChangeTable = (typeof DB_CHANGE_TABLES)[number];

export type DbChange = { table: DbChangeTable };

export type DbChangeListener = (change: DbChange) => void;

type Subscription = { listener: DbChangeListener; onError: ((err: unknown) => void) | undefined };

const REGISTRY_KEY = Symbol.for('oplati.db.change-feed');

function registry(): Set<Subscription> {
  const g = globalThis as { [REGISTRY_KEY]?: Set<Subscription> };
  g[REGISTRY_KEY] ??= new Set();
  return g[REGISTRY_KEY];
}

/** Подписаться на изменения; возвращает отписку. */
export function onDbChange(
  listener: DbChangeListener,
  opts: { onError?: (err: unknown) => void } = {},
): () => void {
  const subscription: Subscription = { listener, onError: opts.onError };
  registry().add(subscription);
  return () => {
    registry().delete(subscription);
  };
}

/** Сообщить об изменении таблицы. Никогда не бросает. */
export function emitDbChange(table: DbChangeTable): void {
  const change: DbChange = { table };
  for (const subscription of registry()) {
    try {
      subscription.listener(change);
    } catch (err) {
      subscription.onError?.(err);
    }
  }
}
