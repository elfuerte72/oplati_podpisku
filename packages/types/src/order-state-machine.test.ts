import { describe, expect, it } from 'vitest';

import {
  allowedTransitions,
  isAllowedTransition,
  OrderTransitionError,
  orderStatus,
  PURCHASED_ORDER_STATUSES,
  REFUND_OR_FAILED_ORDER_STATUSES,
  type OrderStatus,
} from './order-state-machine.ts';

describe('state machine', () => {
  it('каждый статус есть в allowedTransitions', () => {
    for (const s of orderStatus.options) {
      expect(allowedTransitions).toHaveProperty(s);
    }
  });

  it('терминальные статусы не имеют исходящих переходов', () => {
    const terminals: OrderStatus[] = ['refunded', 'cancelled', 'expired'];
    for (const t of terminals) {
      expect(allowedTransitions[t]).toEqual([]);
    }
  });

  it('ready_for_payment протухает: → expired разрешён (фикс H-2 аудита 2026-07-18)', () => {
    // «Цена зафиксирована до expiresAt» обязана форситься сервером: черновик с
    // истёкшей фиксацией курса хоронится cron'ом/гейтом payments-create, иначе
    // заказ остаётся вечно оплатимым по устаревшему курсу.
    expect(isAllowedTransition('ready_for_payment', 'expired')).toBe(true);
  });

  it('isAllowedTransition: разрешённый переход → true', () => {
    expect(isAllowedTransition('draft', 'clarifying')).toBe(true);
    expect(isAllowedTransition('ready_for_payment', 'pending_payment')).toBe(true);
    expect(isAllowedTransition('pending_payment', 'paid')).toBe(true);
    expect(isAllowedTransition('paid', 'in_fulfillment')).toBe(true);
    expect(isAllowedTransition('in_fulfillment', 'completed')).toBe(true);
  });

  it('isAllowedTransition: запрещённый переход → false', () => {
    expect(isAllowedTransition('draft', 'paid')).toBe(false);
    expect(isAllowedTransition('paid', 'pending_payment')).toBe(false);
    expect(isAllowedTransition('completed', 'paid')).toBe(false);
    expect(isAllowedTransition('refunded', 'paid')).toBe(false);
  });

  it('MVP-кейсы из плана', () => {
    // План:
    //   pending_payment → paid | expired | cancelled | failed
    expect(isAllowedTransition('pending_payment', 'paid')).toBe(true);
    expect(isAllowedTransition('pending_payment', 'expired')).toBe(true);
    expect(isAllowedTransition('pending_payment', 'cancelled')).toBe(true);
    expect(isAllowedTransition('pending_payment', 'failed')).toBe(true);
    //   paid → in_fulfillment | failed | refund_requested
    expect(isAllowedTransition('paid', 'in_fulfillment')).toBe(true);
    expect(isAllowedTransition('paid', 'failed')).toBe(true);
    expect(isAllowedTransition('paid', 'refund_requested')).toBe(true);
    //   refund_requested → refunded | completed
    expect(isAllowedTransition('refund_requested', 'refunded')).toBe(true);
    expect(isAllowedTransition('refund_requested', 'completed')).toBe(true);
  });

  it('payment_review: вход только из pending_payment, исходы paid/failed/cancelled', () => {
    // Антифрод-трек (тикет 04): «банк держит перевод» / «клиент говорит, что
    // оплатил». Заказ с (возможно) зафиксированными деньгами НЕ протухает.
    expect(isAllowedTransition('pending_payment', 'payment_review')).toBe(true);
    expect(isAllowedTransition('payment_review', 'paid')).toBe(true);
    expect(isAllowedTransition('payment_review', 'failed')).toBe(true);
    expect(isAllowedTransition('payment_review', 'cancelled')).toBe(true);

    // Не протухает и не возникает из черновика: на проверку попадает только
    // заказ, по которому уже был выставлен счёт.
    expect(isAllowedTransition('payment_review', 'expired')).toBe(false);
    expect(isAllowedTransition('ready_for_payment', 'payment_review')).toBe(false);
    expect(isAllowedTransition('paid', 'payment_review')).toBe(false);
  });

  it('payment_review — НЕ «покупка состоялась» и НЕ отменённая покупка', () => {
    // Деньги ещё не подтверждены провайдером: реферальные начисления, счётчики
    // профиля и выборки «куплено» не должны видеть такой заказ.
    expect(PURCHASED_ORDER_STATUSES).not.toContain('payment_review');
    expect(REFUND_OR_FAILED_ORDER_STATUSES).not.toContain('payment_review');
  });

  it('OrderTransitionError: поля заполнены', () => {
    const err = new OrderTransitionError('order-1', 'draft', 'paid');
    expect(err.name).toBe('OrderTransitionError');
    expect(err.orderId).toBe('order-1');
    expect(err.from).toBe('draft');
    expect(err.to).toBe('paid');
    expect(err.message).toContain('order-1');
    expect(err.message).toContain('draft');
    expect(err.message).toContain('paid');
  });
});
