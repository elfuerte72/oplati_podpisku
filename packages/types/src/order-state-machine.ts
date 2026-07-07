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
]);

export type OrderStatus = z.infer<typeof orderStatus>;

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
  ready_for_payment: ['pending_payment', 'cancelled'],
  pending_payment: ['paid', 'expired', 'cancelled', 'failed'],
  paid: ['in_fulfillment', 'failed', 'refund_requested'],
  in_fulfillment: ['completed', 'failed'],
  completed: ['refund_requested'],
  failed: ['refund_requested'],
  refund_requested: ['refunded', 'completed', 'cancelled'],
  refunded: [],
  cancelled: [],
  expired: [],
};

export function isAllowedTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (allowedTransitions[from] as readonly OrderStatus[]).includes(to);
}

/** Backward-compat alias — старые модули используют `canTransition`. */
export const canTransition = isAllowedTransition;

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
