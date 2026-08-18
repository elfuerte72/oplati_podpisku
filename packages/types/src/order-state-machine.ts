import { z } from 'zod';

/**
 * State machine жизненного цикла заказа.
 *
 * Источник правды для разрешённых переходов — эта таблица. `transitionOrder()`
 * в `@oplati/db` обязан валидировать переход через `isAllowedTransition` ДО
 * `UPDATE orders.status` и `INSERT order_events` (см. CLAUDE.md → архитектурные
 * инварианты, пункт 4).
 *
 * Полная схема: docs/state-machine.md.
 */

export const orderStatus = z.enum([
  'draft',
  'clarifying',
  'kyc_required',
  'ready_for_payment',
  'pending_payment',
  'paid',
  'in_fulfillment',
  'completed',
  'failed',
  'cancelled',
  'expired',
  'refund_requested',
  'refunded',
  // «Платёж на проверке» (антифрод-трек, Р6): банк держит перевод (poll увидел
  // холд провайдера) или клиент говорит «оплатил, а заказ не подтвердился».
  // Заказ НЕ протухает по таймеру; исход решает провайдер/оператор.
  'payment_review',
]);

export type OrderStatus = z.infer<typeof orderStatus>;

/**
 * Статусы, означающие «покупка состоялась»: деньги приняты и заказ не провалился.
 *
 * ЕДИНСТВЕННЫЙ источник этого понятия. Оно применяется в расходящихся местах —
 * оборот сети в реферальной прогрессии, витрина партнёра, выборка пропущенных
 * начислений, счётчики профиля в кабинете, — и до этого список был объявлен в
 * каждом из них отдельно. Новый статус развёл бы их молча: партнёр видел бы одну
 * сеть, а ставку получал бы по другой.
 *
 * ⚠️ `failed` сюда не входит намеренно: провалившийся заказ маржи не приносит, и
 * начисления по нему гасятся (R-1).
 */
export const PURCHASED_ORDER_STATUSES: readonly OrderStatus[] = [
  'paid',
  'in_fulfillment',
  'completed',
] as const;

/**
 * Статусы оплаченного заказа, при которых деньги клиенту НЕ остаются у нас:
 * фулфилмент провалился или оформляется/сделан возврат.
 *
 * Пара к `PURCHASED_ORDER_STATUSES`: реферальная комиссия платится из маржи
 * состоявшейся покупки, поэтому по этим статусам начисления гасятся (R-1).
 *
 * ⚠️ `failed` НЕ терминален (`failed → refund_requested → refunded|completed`),
 * поэтому привязывать отмену только к нему нельзя: если inline-отмена не
 * отработала, а оператор за это время увёл заказ в возврат, комиссия осталась
 * бы у партнёра по заказу, деньги за который вернули клиенту.
 *
 * ⚠️ `refund_requested` сюда НЕ входит намеренно: это ЗАПРОС возврата, который
 * ещё могут отклонить (`refund_requested → completed`), а гашение необратимо —
 * досчитать начисление заново нечем (recovery видит только заказы без строк
 * ledger'а, повторная вставка упирается в частичный UNIQUE). Ждём разрешения:
 * станет `refunded` — погасим тогда.
 *
 * `cancelled` входит: путь `paid → refund_requested → cancelled` легален
 * (возврат оформили и закрыли отменой), и без него комиссия по такому заказу не
 * гасилась бы ни отменой, ни бэкстопом — дыра ровно того же рода, что закрывает
 * R-1 (находка ревью). До оплаты `cancelled` безвреден: начислений там нет.
 * `expired` не входит — этот статус недостижим из оплаченных.
 */
export const REFUND_OR_FAILED_ORDER_STATUSES: readonly OrderStatus[] = [
  'failed',
  'refunded',
  'cancelled',
] as const;

/**
 * Допустимые переходы. Любой переход, не указанный здесь, считается багом и
 * `transitionOrder()` бросит `OrderTransitionError`.
 *
 * Терминальные статусы без исходящих переходов — `cancelled`, `refunded`,
 * `expired` (заказ не пере-открываем — заводим новый). `failed` и `completed`
 * квази-терминальны: из них разрешён единственный переход `→ refund_requested`
 * (возврат оплаченного, но не исполненного / уже завершённого заказа).
 */
export const allowedTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ['clarifying', 'ready_for_payment', 'cancelled'],
  clarifying: ['kyc_required', 'ready_for_payment', 'cancelled'],
  kyc_required: ['clarifying', 'cancelled'],
  // → expired: фиксация цены (курс снапшотится при propose) протухла по
  // orders.expires_at — черновик хоронит cron expire-payments или гейт
  // payments-create; вечно оплатимый заказ по устаревшему курсу — дыра в марже.
  ready_for_payment: ['pending_payment', 'cancelled', 'expired'],
  // → payment_review: банк поставил перевод на проверку (акторы:
  // payment_provider — poll увидел холд; user — кнопка «я оплатил»).
  pending_payment: ['paid', 'expired', 'cancelled', 'failed', 'payment_review'],
  paid: ['in_fulfillment', 'failed', 'refund_requested'],
  in_fulfillment: ['completed', 'failed'],
  completed: ['refund_requested'],
  // → in_fulfillment: РУЧНАЯ выдача (тикет 06 админ-панели). Заказ, который
  // выдали руками, не должен вечно числиться провалившимся: пока он `failed`,
  // он не в выручке (`PURCHASED_ORDER_STATUSES`) и комиссия партнёра по нему
  // погашена (`REFUND_OR_FAILED_ORDER_STATUSES`). Случай ORD-J6TBP от
  // 2026-08-14: клиент заплатил 11 680 ₽, карту выпустить не смогли (не хватило
  // баланса VCC-субаккаунта), реквизиты отправили вручную.
  //
  // ⚠️ Именно в `in_fulfillment`, а НЕ сразу в `completed`: оператор делает два
  // шага («беру в ручную выдачу» → «выдал»), и `order_events` — append-only, по
  // нему считается выручка. Прыжок в `completed` не оставил бы записи о том,
  // что работа вообще начиналась, и кто её начал.
  failed: ['refund_requested', 'in_fulfillment'],
  refund_requested: ['refunded', 'completed', 'cancelled'],
  refunded: [],
  cancelled: [],
  expired: [],
  // Заказ с (возможно) зафиксированными деньгами: НЕ протухает (`expired`
  // недостижим намеренно — конец истории «оплатил, а получил „срок истёк“»),
  // исходы — оплата подтвердилась / отказ / отмена. Залипший дольше 7 дней
  // алертится DM владельцу без автозакрытия (poll-payment).
  payment_review: ['paid', 'failed', 'cancelled'],
};

export function isAllowedTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (allowedTransitions[from] as readonly OrderStatus[]).includes(to);
}

/**
 * Бросается из `transitionOrder()` если переход запрещён `allowedTransitions`.
 * Carrier-поля `orderId`, `from`, `to` позволяют залогировать причину без
 * парсинга текста сообщения.
 */
export class OrderTransitionError extends Error {
  readonly orderId: string;
  readonly from: OrderStatus;
  readonly to: OrderStatus;

  constructor(orderId: string, from: OrderStatus, to: OrderStatus) {
    super(`order ${orderId}: transition ${from} → ${to} not allowed`);
    this.name = 'OrderTransitionError';
    this.orderId = orderId;
    this.from = from;
    this.to = to;
  }
}
