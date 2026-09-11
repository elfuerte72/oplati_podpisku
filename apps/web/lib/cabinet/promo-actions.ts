import 'server-only';

import { getDb, getOrderById } from '@oplati/db';

import { promoRejectText } from '../payments/promo.ts';
import { checkPromoForOrderSafe, isPromoEnabled } from '../promo/apply.ts';
import { buildOrderBonusView } from './read.ts';
import { isPayableStatus, type OrderBonusView } from './types.ts';

/**
 * Действие `promo-check` кабинета: «что мне даст этот код на этом заказе»
 * (трек promo-codes).
 *
 * Занятия НЕ делает. Клиент, который ввёл код и передумал платить, не должен
 * оставлять за собой израсходованную активацию — занимает её `payments/create`
 * в момент оплаты, под локами и с перепроверкой лимитов.
 *
 * ⚠️ Ответ несёт ПЕРЕСЧИТАННОЕ предложение по баллам. Порядок «промокод первый,
 * баллы вторые» означает, что потолок баллов зависит от промокода, и отдать одну
 * скидку без второй значило бы показать экрану пару чисел, которых вместе не
 * бывает: сумма на кнопке разошлась бы с суммой счёта.
 */
export type CabinetPromoCheckResult =
  | {
      ok: true;
      discountKopecks: number;
      /** Урезали ли номинал — экран обязан сказать об этом вслух. */
      capped: boolean;
      /** Предложение по баллам ПОСЛЕ промокода; `null` — баллов на экране нет. */
      bonusOffer: OrderBonusView | null;
    }
  | { ok: false; error: 'not_found' | 'not_payable' | 'disabled' | 'rejected'; message?: string };

export async function checkPromoForCabinet(
  userId: string,
  orderId: string,
  code: string,
): Promise<CabinetPromoCheckResult> {
  if (!isPromoEnabled()) return { ok: false, error: 'disabled' };

  const order = await getOrderById(getDb(), orderId);
  // Ownership: чужой заказ и несуществующий отвечают одинаково — не раскрываем
  // существование чужого заказа (то же правило, что в `buildOrderDetail`).
  if (!order || order.userId !== userId) return { ok: false, error: 'not_found' };
  // Заказу с уже выставленным счётом код применить нельзя: переставить сумму
  // инвойса мы не умеем (API правки нет ни у одного шлюза), а второй счёт на
  // заказ запрещён частичным UNIQUE.
  if (!isPayableStatus(order.status) || order.status !== 'ready_for_payment') {
    return { ok: false, error: 'not_payable' };
  }

  const checked = await checkPromoForOrderSafe({ order, code });
  if (!checked.ok) {
    return { ok: false, error: 'rejected', message: promoRejectText(checked.reason) };
  }

  return {
    ok: true,
    discountKopecks: checked.plan.discountKopecks,
    capped: checked.plan.capped,
    bonusOffer: await buildOrderBonusView(order, checked.plan.discountKopecks),
  };
}
