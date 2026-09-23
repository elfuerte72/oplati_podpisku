/**
 * Что показывает вкладка «Карта» Mini App (трек miniapp-tabs, тикет 06).
 *
 * Главное после оплаты — шаг 3: «оплати сервис этой картой». До вкладок его
 * экран открывался только через красную ссылку «Не проходит оплата?», и из
 * восьми оплативших «Подписка оформлена» не нажал никто. Поэтому здесь правило,
 * КОГДА этот шаг показывать, вынесено в чистую функцию с тестами: спрятать его
 * от того, кто его не сделал, — потерять клиента на последнем метре; вечно
 * показывать тому, кто давно оформил, — превратить подсказку в шум.
 */

/** Сколько дней после заказа ещё напоминаем про шаг 3. */
export const NEXT_STEP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Статусы «деньги пришли, карта в пути». */
const ISSUING_STATUSES = new Set(['paid', 'in_fulfillment']);

export type CardTabOrderLike = {
  orderId: string;
  status: string;
  createdAt: string;
  /**
   * Карта, выданная по заказу. Необязательное: снапшот сервера прошлого деплоя
   * поля не несёт, и такой заказ просто не относится ни к одной карте.
   */
  cardId?: string | null | undefined;
  /** Клиент отметил «Подписка оформлена» (событие `subscription_activated`). */
  subscriptionActivated?: boolean | undefined;
};

export type CardTabCardLike = { id: string; status: string; createdAt: string };

export type CardTabState<O extends CardTabOrderLike, C extends CardTabCardLike> =
  | { kind: 'none' }
  | {
      kind: 'issuing';
      order: O;
      /** Деньги ложатся на уже выпущенную активную карту (второй сервис). */
      topUp: boolean;
    }
  | {
      kind: 'active';
      card: C;
      /** Заказ, по которому клиент ещё не оформил подписку; null — шаг сделан. */
      nextStep: O | null;
      /** Выполненные заказы по этой карте, свежие сверху. */
      cardOrders: O[];
    };

const byCreatedDesc = (a: { createdAt: string }, b: { createdAt: string }) =>
  b.createdAt.localeCompare(a.createdAt);

export function selectCardTabState<O extends CardTabOrderLike, C extends CardTabCardLike>(
  snapshot: { orders: readonly O[]; cards: readonly C[] },
  now: number = Date.now(),
): CardTabState<O, C> {
  const { orders, cards } = snapshot;

  // Выпуск важнее готовой карты: только что оплативший ждёт именно эту карту,
  // и показать ему прошлую с «остался один шаг» по прошлому сервису — сбить.
  const issuing = [...orders]
    .filter(
      (o) =>
        ISSUING_STATUSES.has(o.status) &&
        !(o.cardId && cards.some((c) => c.id === o.cardId)),
    )
    .sort(byCreatedDesc)[0];
  if (issuing) {
    return { kind: 'issuing', order: issuing, topUp: cards.some((c) => c.status === 'active') };
  }

  const card =
    cards.find((c) => c.status === 'active') ?? [...cards].sort(byCreatedDesc)[0] ?? null;
  if (!card) return { kind: 'none' };

  const cardOrders = orders
    .filter((o) => o.status === 'completed' && o.cardId === card.id)
    .sort(byCreatedDesc);

  // Решает ПОСЛЕДНИЙ заказ по карте: отметку ставят по свежему сервису, и
  // старый неотмеченный заказ не должен всплывать поверх неё.
  const latest = cardOrders[0];
  const nextStep =
    latest &&
    latest.subscriptionActivated !== true &&
    now - Date.parse(latest.createdAt) <= NEXT_STEP_MAX_AGE_MS
      ? latest
      : null;

  return { kind: 'active', card, nextStep, cardOrders };
}
