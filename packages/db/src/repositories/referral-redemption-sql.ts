import { sql, type SQL } from 'drizzle-orm';

/**
 * ЕДИНСТВЕННОЕ определение «списание живо»: баллы всё ещё у нас, а не у клиента.
 *
 * Модуль отдельный и без импортов намеренно: условие нужно и формуле баланса
 * (`referral-accruals.ts`), и витринам панели (`panel.ts`), и выборке сторожа
 * (`referral-redemptions.ts`). Держать его в любом из них означало бы цикл
 * импортов, а держать по копии — зеркало на денежном пути: панель показывала бы
 * скидку, которую баланс уже вернул, а сверщик не видел бы того, что видит
 * оператор.
 *
 * Правило:
 *
 *  - `released` не считается никогда — баллы уже вернули (системный откат или
 *    решение оператора);
 *  - `reserved` под заказом в `expired`/`cancelled` не считается ТОЛЬКО пока по
 *    заказу нет УСПЕШНОГО платежа. Это и есть «денег не приходило»: протухший
 *    черновик, отменённый заказ.
 *
 * ⚠️ Оговорка про успешный платёж не теоретическая. Крон `expire-payments`
 * хоронит заказ и клеймит платёж `pending → failed`, а опоздавший вебхук
 * приходит уже после: путь `paid_after_terminal` (деньги приняты, заказ мёртв)
 * не доходит до `claimBonusSpent`, и строка остаётся `reserved` на `expired`.
 * Без этой оговорки клиент получал бы и скидку по оплаченному счёту, и баллы
 * обратно — молча. Такие заказы всё равно разбирает человек (алёрт «нужен
 * ручной возврат»), и баллы ждут его решения вместе с деньгами.
 */
export function liveRedemptionSql(
  redemption: SQL | string = sql`referral_redemptions`,
  order: SQL | string = sql`orders`,
) {
  const r = typeof redemption === 'string' ? sql.raw(redemption) : redemption;
  const o = typeof order === 'string' ? sql.raw(order) : order;
  return sql`(
    ${r}.status <> 'released'
    AND NOT (
      ${r}.status = 'reserved'
      AND ${o}.status IN ('expired', 'cancelled')
      AND NOT EXISTS (
        SELECT 1 FROM payments p
        WHERE p.order_id = ${r}.order_id AND p.status = 'succeeded'
      )
    )
  )`;
}
