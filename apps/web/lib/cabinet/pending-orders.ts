/**
 * Отбор заказов для блока «Ждут оплаты» на главном экране Mini App.
 *
 * Живёт отдельной чистой функцией, а не фильтром внутри JSX: правило «что
 * показывать» здесь не одно — кроме `payable` (его считает сервер по статусу)
 * есть срок. Протухший заказ остаётся `payable` до ближайшего прогона крона
 * `expire-payments` (шаг 15 минут), и попади он в список — клиент нажал бы
 * «Оплатить» и получил «срок фиксации цены истёк». Предлагать оплату тому,
 * что уже мертво, хуже, чем не показать заказ, который всё равно вот-вот
 * закроется сам.
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
