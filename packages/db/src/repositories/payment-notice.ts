import { sql } from 'drizzle-orm';

import type { DB } from '../index.ts';
import { PURCHASED_STATUSES_SQL } from './order-status-sql.ts';

/**
 * Карточка оплаченного заказа для уведомления персоналу «Оплата принята»
 * (`lib/jobs/notify-payment-ops.ts`, тема «Платежи» ops-группы).
 *
 * Один запрос вместо пяти: уведомление уходит из `after()` после ответа
 * вебхука, и каждая лишняя поездка в базу — лишнее окно, в котором процесс
 * может умереть до отправки. Форма строк — как у `dailyPaidOrders` (дневной
 * отчёт): тот же способ назвать сервис, тариф и скидку, чтобы «кто и что купил»
 * в теме и в утреннем отчёте читалось одинаково.
 *
 * Деньги — integer в копейках (инвариант 3). Скидка считается по строкам
 * списаний в ЛЮБОМ незакрытом состоянии (`reserved` или `spent`): промокод и
 * баллы переводятся в `spent` рядом с платежом, и уведомление могло бы
 * увидеть строку за миг до этого. Разницу «цена − счёт» вызывающий считает
 * сам по `amountKopecks` и `payment.amountKopecks` — она первична, а строки
 * списаний только подписывают, откуда скидка.
 *
 * «Покупка №N» — число заказов клиента в `PURCHASED_ORDER_STATUSES`, включая
 * этот: к моменту вызова заказ уже в `paid` (или дальше). Тот же список
 * статусов, что у карточки клиента в панели и у выручки «Отчётов».
 */

export type PaidOrderNotice = {
  orderId: string;
  shortId: string;
  status: string;
  paidAt: Date | null;
  /** Полная цена заказа, копейки (`orders.amount_rub`). */
  amountKopecks: number | null;
  /** Надбавка за выпуск карты внутри цены, копейки. */
  cardIssueFeeKopecks: number;
  /** Скидка по промокоду (строки `reserved`/`spent`), копейки. */
  promoDiscountKopecks: number;
  /** Скидка реферальными баллами (строки `reserved`/`spent`), копейки. */
  bonusDiscountKopecks: number;
  serviceName: string | null;
  tierName: string | null;
  originalAmount: number | null;
  originalCurrency: string | null;
  customDescription: string | null;
  client: {
    userId: string;
    displayName: string | null;
    telegramUsername: string | null;
    telegramId: string | null;
    since: Date;
    /** Состоявшихся покупок у клиента, включая эту. */
    purchases: number;
  };
  /** Последний успешный платёж по заказу; `null`, если его ещё нет в базе. */
  payment: {
    provider: string;
    /** Сумма счёта, копейки (`payments.amount_rub`) — то, что запрошено у шлюза. */
    amountKopecks: number;
    recoveredViaPolling: boolean;
    completedAt: Date | null;
  } | null;
};

function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export async function findPaidOrderNotice(db: DB, orderId: string): Promise<PaidOrderNotice | null> {
  const rows = await db.execute<{
    id: string;
    short_id: string;
    status: string;
    paid_at: string | Date | null;
    amount_rub: string | number | null;
    card_issue_fee_kopecks: string | number | null;
    promo_discount: string | number | null;
    bonus_discount: string | number | null;
    service_name: string | null;
    tier_name: string | null;
    original_amount: string | number | null;
    original_currency: string | null;
    custom_description: string | null;
    user_id: string;
    display_name: string | null;
    telegram_username: string | null;
    telegram_id: string | null;
    user_created_at: string | Date;
    purchases: string | number;
    provider: string | null;
    payment_amount: string | number | null;
    recovered_via_polling: boolean | null;
    payment_completed_at: string | Date | null;
  }>(sql`
    SELECT o.id, o.short_id, o.status::text AS status, o.paid_at, o.amount_rub,
           o.card_issue_fee_kopecks,
           COALESCE((SELECT sum(pr.discount_kopecks) FROM promo_redemptions pr
                      WHERE pr.order_id = o.id AND pr.status IN ('reserved', 'spent')), 0) AS promo_discount,
           COALESCE((SELECT sum(rr.discount_kopecks) FROM referral_redemptions rr
                      WHERE rr.order_id = o.id AND rr.status IN ('reserved', 'spent')), 0) AS bonus_discount,
           s.name AS service_name,
           o.parameters ->> 'tierName' AS tier_name,
           o.original_amount, o.original_currency,
           o.custom_service_description AS custom_description,
           u.id AS user_id, u.display_name, u.telegram_username, u.telegram_id,
           u.created_at AS user_created_at,
           (SELECT count(*) FROM orders x
             WHERE x.user_id = o.user_id AND x.status IN ${PURCHASED_STATUSES_SQL}) AS purchases,
           p.provider::text AS provider, p.amount_rub AS payment_amount,
           p.recovered_via_polling, p.completed_at AS payment_completed_at
    FROM orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN services s ON s.id = o.service_id
    LEFT JOIN LATERAL (
      SELECT provider, amount_rub, recovered_via_polling, completed_at
      FROM payments
      WHERE order_id = o.id AND status = 'succeeded'
      ORDER BY completed_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    ) p ON true
    WHERE o.id = ${orderId}
    LIMIT 1
  `);
  const r = rows[0];
  if (!r) return null;
  return {
    orderId: r.id,
    shortId: r.short_id,
    status: r.status,
    paidAt: r.paid_at == null ? null : new Date(r.paid_at),
    amountKopecks: r.amount_rub == null ? null : toInt(r.amount_rub),
    cardIssueFeeKopecks: toInt(r.card_issue_fee_kopecks),
    promoDiscountKopecks: toInt(r.promo_discount),
    bonusDiscountKopecks: toInt(r.bonus_discount),
    serviceName: r.service_name,
    tierName: r.tier_name,
    originalAmount: r.original_amount == null ? null : toInt(r.original_amount),
    originalCurrency: r.original_currency,
    customDescription: r.custom_description,
    client: {
      userId: r.user_id,
      displayName: r.display_name,
      telegramUsername: r.telegram_username,
      telegramId: r.telegram_id,
      since: new Date(r.user_created_at),
      purchases: toInt(r.purchases),
    },
    payment:
      r.provider == null || r.payment_amount == null
        ? null
        : {
            provider: r.provider,
            amountKopecks: toInt(r.payment_amount),
            recoveredViaPolling: r.recovered_via_polling === true,
            completedAt: r.payment_completed_at == null ? null : new Date(r.payment_completed_at),
          },
  };
}
