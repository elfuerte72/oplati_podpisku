/**
 * Поддержка в панели (тикет 10) — правила, отделённые от Next и от БД.
 *
 * ⚠️ Клиенту ответ приходит ОТ БОТА: что за ботом человек, клиент не знает.
 * Значит, ответ обязан быть похож на бота — без подписи оператора и без
 * служебных пометок.
 */

import { THREAD_ROLE_LABELS } from './labels';

/** Пустой ответ отправлять нечего, а простыню Telegram не примет. */
export const SUPPORT_REPLY_MIN = 2;
export const SUPPORT_REPLY_MAX = 3500;

/**
 * Сколько дней живёт переписка — ИЗ общего модуля политики хранения, а не
 * числом здесь: лента обрывается не потому, что «данные потерялись», и экран
 * это объясняет. Копия числа врала бы ровно тому, кто её читает.
 */
export { MESSAGES_RETENTION_DAYS as SUPPORT_HISTORY_DAYS } from '@/lib/retention-policy';

/**
 * Почему поля ответа нет. Показывается вместо него — молчащий экран хуже.
 * Тексты — `SUPPORT_BLOCK_TEXT` в словаре панели (`labels.ts`).
 */
export type SupportReplyBlockReason = 'no_telegram' | 'assigned_to_other';

export function supportReplyBlockReason(input: {
  clientTelegramId: string | null;
  assignedOperatorId: string | null;
  actorId: string;
}): SupportReplyBlockReason | null {
  if (!input.clientTelegramId) return 'no_telegram';
  if (input.assignedOperatorId && input.assignedOperatorId !== input.actorId) {
    return 'assigned_to_other';
  }
  return null;
}

/**
 * Роль строки в ленте — человеческим словом.
 *
 * «Бот» и «оператор» различаются намеренно: клиент их не различает, а менеджер
 * обязан видеть, где ответил автомат, а где живой человек.
 */
export function supportRoleLabel(role: string, staffName: string | null): string {
  if (role === 'user') return THREAD_ROLE_LABELS.user;
  if (role === 'operator') {
    return staffName ? `${THREAD_ROLE_LABELS.operator} · ${staffName}` : THREAD_ROLE_LABELS.operator;
  }
  if (role === 'assistant') return THREAD_ROLE_LABELS.assistant;
  return role;
}
