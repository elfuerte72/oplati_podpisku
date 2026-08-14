import { sql } from 'drizzle-orm';
import { PURCHASED_ORDER_STATUSES, REFUND_OR_FAILED_ORDER_STATUSES } from '@oplati/types';

/**
 * SQL-фрагмент списка «покупка состоялась» для `status IN (...)`.
 *
 * Собирается из единственного источника (`PURCHASED_ORDER_STATUSES` в
 * @oplati/types), а не пишется литералом в каждом запросе: до этого один и тот
 * же список жил отдельно в прогрессии, витрине партнёра, выборке пропущенных
 * начислений и счётчиках профиля — четыре независимых копии одного продуктового
 * понятия, которые новый статус развёл бы молча.
 */
export const PURCHASED_STATUSES_SQL = sql`(${sql.join(
  PURCHASED_ORDER_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)})`;

/**
 * SQL-фрагмент статусов «оплачено, но деньги у нас не остаются» (провал или
 * возврат) — по ним гасятся реферальные начисления. Тот же приём единственного
 * источника, что и у `PURCHASED_STATUSES_SQL`.
 */
export const REFUND_OR_FAILED_STATUSES_SQL = sql`(${sql.join(
  REFUND_OR_FAILED_ORDER_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)})`;
