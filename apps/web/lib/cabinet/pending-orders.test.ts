import { describe, expect, it } from 'vitest';

import { selectPendingPaymentOrders } from './pending-orders.ts';

/**
 * Блок «Ждут оплаты» на главном экране кабинета. Правило отбора одно, но
 * ошибиться в нём дорого в обе стороны: показать протухший заказ — привести
 * клиента к кнопке «Оплатить», которая ответит «срок фиксации цены истёк»;
 * спрятать лишнее — отнять единственный вход в собственный заказ.
 */

const NOW = Date.parse('2026-09-07T12:00:00.000Z');

function order(overrides: { payable?: boolean; expiresAt?: string | null } = {}) {
  return {
    orderId: 'o1',
    payable: overrides.payable ?? true,
    expiresAt: overrides.expiresAt === undefined ? '2026-09-07T13:00:00.000Z' : overrides.expiresAt,
  };
}

describe('selectPendingPaymentOrders', () => {
  it('оставляет только оплатимые заказы', () => {
    const result = selectPendingPaymentOrders(
      [order({ payable: true }), order({ payable: false })],
      NOW,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.payable).toBe(true);
  });

  it('прячет заказ с истёкшим сроком — крон похоронит его в ближайшие 15 минут', () => {
    const expired = order({ expiresAt: '2026-09-07T11:59:00.000Z' });

    expect(selectPendingPaymentOrders([expired], NOW)).toEqual([]);
  });

  it('заказ без срока показывает: спрятать его значит отнять и оплату, и отмену', () => {
    const noDeadline = order({ expiresAt: null });

    expect(selectPendingPaymentOrders([noDeadline], NOW)).toHaveLength(1);
  });

  it('неразбираемую дату не считает истёкшей', () => {
    const broken = order({ expiresAt: 'не-дата' });

    expect(selectPendingPaymentOrders([broken], NOW)).toHaveLength(1);
  });

  it('сортирует по близости срока: что горит — сверху', () => {
    const later = { ...order({ expiresAt: '2026-09-07T14:00:00.000Z' }), orderId: 'later' };
    const sooner = { ...order({ expiresAt: '2026-09-07T12:30:00.000Z' }), orderId: 'sooner' };
    const noDeadline = { ...order({ expiresAt: null }), orderId: 'no-deadline' };

    const result = selectPendingPaymentOrders([later, noDeadline, sooner], NOW);

    expect(result.map((o) => o.orderId)).toEqual(['sooner', 'later', 'no-deadline']);
  });
});
