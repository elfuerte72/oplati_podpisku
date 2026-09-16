import { sql } from 'drizzle-orm';

import type { DB } from '../index.ts';
import { PURCHASED_STATUSES_SQL } from './order-status-sql.ts';
import { toInt } from './pg-numbers.ts';
import { livePromoRedemptionSql } from './promo-redemption-sql.ts';
import { liveRedemptionSql } from './referral-redemption-sql.ts';

/**
 * Карточка оплаченного заказа для уведомления персоналу «Оплата принята»
 * (`lib/jobs/notify-payment-ops.ts`, тема «Платежи» ops-группы).
 *
 * Один запрос вместо пяти: уведомление уходит из `after()` после ответа
 * вебхука, и каждая лишняя поездка в базу — лишнее окно, в котором процесс
 * может умереть до отправки. Форма строк — как у `dailyPaidOrders` (дневной
 * отчёт): те же поля сервиса, тарифа и клиента, чтобы подписи в теме и в
 * утреннем отчёте собирались одними функциями.
 *
 * Деньги — integer в копейках (инвариант 3). «Списание живо» — те же условия,
 * что у баланса партнёра, витрин панели и начислений (`liveRedemptionSql`,
 * `livePromoRedemptionSql`): третьего написания этого правила в проекте нет.
 * Разницу «цена − счёт» вызывающий считает по `amountKopecks` и
 * `payment.amountKopecks` — она первична, строки списаний только подписывают,
 * откуда скидка.
 *
 * «Покупка №N» — заказы клиента в `PURCHASED_ORDER_STATUSES` (тот же список,
 * что у карточки клиента и выручки «Отчётов») ПЛЮС этот заказ независимо от
 * его статуса: `issueCard` бежит параллельно и мог уже увести заказ в
 * `failed`, а покупка при этом состоялась — деньги приняты.
 *
 * Платёж обязателен: карточка нужна только после `claimPaymentSucceeded`, и
 * заказ без `succeeded`-платежа здесь означает «данных ещё нет» — `null`.
 * `tierName` читается из `parameters` так же, как в дневном отчёте; сегодня
 * его туда никто не пишет (BACKLOG) — тогда сервис подписывается ценой.
 */

export type PaidOrderNotice = {
  shortId: string;
  /** Текущий статус заказа — к моменту чтения выпуск карты мог уже пройти или упасть. */
  status: string;
  /** Полная цена заказа, копейки (`orders.amount_rub`). */
  amountKopecks: number | null;
  /** Надбавка за выпуск карты внутри цены, копейки. */
  cardIssueFeeKopecks: number;
  /** Скидка по промокоду (живое списание), копейки. */
  promoDiscountKopecks: number;
  /** Скидка реферальными баллами (живое списание), копейки. */
  bonusDiscountKopecks: number;
  serviceName: string | null;
  tierName: string | null;
  originalAmount: number | null;
  originalCurrency: string | null;
  customDescription: string | null;
  client: {
    displayName: string | null;
    telegramUsername: string | null;
    telegramId: string | null;
    since: Date;
    /** Состоявшихся покупок у клиента, включая эту. */
    purchases: number;
  };
  payment: {
    provider: string;
    /** Сумма счёта, копейки (`payments.amount_rub`) — то, что запрошено у шлюза. */
    amountKopecks: number;
    recoveredViaPolling: boolean;
  };
};

export async function findPaidOrderNotice(db: DB, orderId: string): Promise<PaidOrderNotice | null> {
  const rows = await db.execute<{
    short_id: string;
    status: string;
    amount_rub: string | number | null;
    card_issue_fee_kopecks: string | number | null;
    promo_discount: string | number | null;
    bonus_discount: string | number | null;
    service_name: string | null;
    tier_name: string | null;
    original_amount: string | number | null;
    original_currency: string | null;
    custom_description: string | null;
    display_name: string | null;
    telegram_username: string | null;
    telegram_id: string | null;
    user_created_at: string | Date;
    purchases: string | number;
    provider: string;
    payment_amount: string | number;
    recovered_via_polling: boolean | null;
  }>(sql`
    SELECT o.short_id, o.status::text AS status, o.amount_rub, o.card_issue_fee_kopecks,
           COALESCE((SELECT sum(pr.discount_kopecks) FROM promo_redemptions pr
                      WHERE pr.order_id = o.id AND ${livePromoRedemptionSql(sql`pr`, sql`o`)}), 0) AS promo_discount,
           COALESCE((SELECT sum(rr.discount_kopecks) FROM referral_redemptions rr
                      WHERE rr.order_id = o.id AND ${liveRedemptionSql(sql`rr`, sql`o`)}), 0) AS bonus_discount,
           s.name AS service_name,
           o.parameters ->> 'tierName' AS tier_name,
           o.original_amount, o.original_currency,
           o.custom_service_description AS custom_description,
           u.display_name, u.telegram_username, u.telegram_id,
           u.created_at AS user_created_at,
           (SELECT count(*) FROM orders x
             WHERE x.user_id = o.user_id
               AND (x.status IN ${PURCHASED_STATUSES_SQL} OR x.id = o.id)) AS purchases,
           p.provider::text AS provider, p.amount_rub AS payment_amount, p.recovered_via_polling
    FROM orders o
    JOIN users u ON u.id = o.user_id
    JOIN payments p ON p.order_id = o.id AND p.status = 'succeeded'
    LEFT JOIN services s ON s.id = o.service_id
    WHERE o.id = ${orderId}
    LIMIT 1
  `);
  const r = rows[0];
  if (!r) return null;
  return {
    shortId: r.short_id,
    status: r.status,
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
      displayName: r.display_name,
      telegramUsername: r.telegram_username,
      telegramId: r.telegram_id,
      since: new Date(r.user_created_at),
      purchases: toInt(r.purchases),
    },
    payment: {
      provider: r.provider,
      amountKopecks: toInt(r.payment_amount),
      recoveredViaPolling: r.recovered_via_polling === true,
    },
  };
}
