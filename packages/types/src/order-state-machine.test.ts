import { describe, expect, it } from 'vitest';

import {
  allowedTransitions,
  isAllowedTransition,
  OrderTransitionError,
  orderStatus,
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
