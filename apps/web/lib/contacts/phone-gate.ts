import 'server-only';

import type { OrderRow } from '@oplati/db';

import { DedupWindow } from '../alerts/dedup-window.ts';
import { notifyOps } from '../alerts/notify-ops.ts';
import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';

/**
 * Гейт «телефон от порога» (антифрод-трек, тикет 05): для заказов от
 * `PHONE_REQUIRED_FROM_RUB` рублей счёт не выставляется без номера в профиле.
 *
 * Порог живёт ТОЛЬКО в env и в теле ответа `422 phone_required` — в UI-тексты
 * не зашивается (инвариант 10: не плодить зеркала). Не задан → фича выключена
 * (безопасный rollout).
 */

const log = childLogger('phone-gate');

/** Порог в ЦЕЛЫХ рублях или null — фича выключена. */
export function phoneRequirementRub(): number | null {
  return serverEnv.PHONE_REQUIRED_FROM_RUB ?? null;
}

// Дедуп DM по заказу: клиент, гоняющий «Оплатить» по кругу без номера, не
// должен превращать личку оператора в ленту. Заказ живёт до протухания —
// одного сообщения на заказ достаточно.
const phoneGateDedup = new DedupWindow(24 * 60 * 60 * 1000);

/** Только для unit-тестов. */
export function resetPhoneGateDedupForTests(): void {
  phoneGateDedup.resetForTests();
}

/**
 * DM оператору «клиент упёрся в гейт телефона» (спека §4.3): счёт не выставлен,
 * заказ доживёт до обычного протухания — оператор может дотянуться до клиента
 * раньше. Best-effort: сбой доставки не меняет ответ клиенту.
 */
export async function notifyPhoneGateBlocked(
  order: Pick<OrderRow, 'id' | 'shortId' | 'amountRub'>,
  thresholdRub: number,
): Promise<void> {
  log.warn({ event: 'payments.create.phone_required', orderId: order.id });
  if (!phoneGateDedup.shouldSend(order.id)) return;
  try {
    await notifyOps(
      `Номера в профиле нет — счёт не выставлен. Заказ живёт до протухания; ` +
        `если клиент выйдет на связь — телефон вводится в контактах заказа.`,
      {
        stream: 'payments',
        title: 'Гейт телефона: счёт не выставлен',
        facts: [
          { label: 'Заказ', value: order.shortId },
          { label: 'Сумма', value: `${((order.amountRub ?? 0) / 100).toFixed(2)} ₽` },
          { label: 'Порог', value: `${thresholdRub} ₽` },
        ],
        action: { text: 'дождаться клиента; телефон вводится в контактах заказа', path: '/admin/pending' },
      },
    );
  } catch (err) {
    log.error({ event: 'payments.create.phone_gate_notify_failed', orderId: order.id, err });
  }
}
