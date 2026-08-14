import { sql } from 'drizzle-orm';
import { PURCHASED_ORDER_STATUSES } from '@oplati/types';

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
