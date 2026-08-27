import { PAYOUT_STATUSES, type PayoutStatus } from '@oplati/types';

import { PAYOUT_STATUS_LABELS } from './labels';

/**
 * Заявки на вывод в панели (тикет 12) — подписи и правила, отделённые от БД.
 *
 * ⚠️ Панель фиксирует ФАКТ выплаты, а не переводит деньги: `settlePayout` —
 * mock и нигде не вызывается. Формулировки на экране обязаны это отражать,
 * иначе кнопка «выплачено» читается как «перевести».
 */

function isPayoutStatus(status: string): status is PayoutStatus {
  return (PAYOUT_STATUSES as readonly string[]).includes(status);
}

export function payoutStatusLabel(status: string): string {
  return isPayoutStatus(status) ? PAYOUT_STATUS_LABELS[status] : status;
}

/**
 * Можно ли решать по заявке.
 *
 * ⚠️ `processing` РЕШАЕМЫЙ. «Выплачено» идёт двумя переходами вне одной
 * транзакции, и упавший между ними процесс оставляет заявку ровно здесь; её
 * сумма при этом продолжает вычитаться из баланса партнёра. Оставь правило на
 * одном `requested` — и вынуть такую заявку можно было бы только SQL'ем на
 * проде. Машина статусов переходы `processing → paid|rejected` разрешает.
 */
export function isPayoutDecidable(status: string): boolean {
  return status === 'requested' || status === 'processing';
}
