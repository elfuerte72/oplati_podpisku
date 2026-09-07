/**
 * Отбор заказов для блока «Ждут оплаты» на главном экране Mini App.
 *
 * Живёт отдельной чистой функцией, а не фильтром внутри JSX: правило «что
 * показывать» здесь не одно — кроме `payable` (его считает сервер по статусу)
 * есть срок, и протухший заказ остаётся `payable` до ближайшего прогона крона
 * `expire-payments` (шаг 15 минут).
 *
 * Истёкший `expires_at` означает разное для двух оплатимых статусов, но в обоих
 * случаях предлагать оплату уже нельзя: у черновика `ready_for_payment` протухла
 * фиксация курса (`payments/create` ответит `409 order_expired`), а у
 * `pending_payment` срок заказа выровнен по сроку счёта — то есть ссылка,
 * которую отдаст «Оплатить», ведёт на мёртвую страницу шлюза. Показать такой
 * заказ хуже, чем не показать: он всё равно закроется сам в ближайшие минуты,
 * а оформить новый можно сразу.
 */

export type PendingOrderLike = {
  /** Оплатим ли заказ по статусу (считает сервер, `isPayableStatus`). */
  payable: boolean;
  /** Когда истекает фиксация цены / срок счёта; ISO или null. */
  expiresAt: string | null;
};

/**
 * Живые заказы, ждущие оплаты, — сначала те, у кого срок ближе.
 *
 * Заказ без `expiresAt` и заказ с неразбираемой датой ПОКАЗЫВАЕМ: срок мы по
 * ним не знаем, а спрятать оплатимый заказ значит отнять у клиента и оплату,
 * и кнопку отмены. Такие уходят в конец списка — торопиться по ним не с чем.
 */
export function selectPendingPaymentOrders<T extends PendingOrderLike>(
  orders: readonly T[],
  now: number = Date.now(),
): T[] {
  const alive = orders.filter((order) => {
    if (!order.payable) return false;
    if (order.expiresAt === null) return true;
    const expiresAtMs = Date.parse(order.expiresAt);
    if (Number.isNaN(expiresAtMs)) return true;
    return expiresAtMs > now;
  });

  return alive.sort((a, b) => expiresAtRank(a) - expiresAtRank(b));
}

function expiresAtRank(order: PendingOrderLike): number {
  if (order.expiresAt === null) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(order.expiresAt);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}
