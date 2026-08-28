/**
 * Поддержка в панели (тикет 10) — правила, отделённые от Next и от БД.
 *
 * ⚠️ Клиенту ответ приходит ОТ БОТА: что за ботом человек, клиент не знает.
 * Значит, ответ обязан быть похож на бота — без подписи оператора и без
 * служебных пометок.
 */

import {
  SUPPORT_AI_META_SOURCE,
  SUPPORT_STATE_META_SOURCE,
  type ConversationModeTrigger,
} from '@oplati/types';

import { lookupLabel } from './format';
import { SUPPORT_MODE_LABELS, THREAD_ROLE_LABELS } from './labels';

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
 * «Бот», «помощник» и «оператор» различаются намеренно: клиент их не
 * различает, а менеджер обязан видеть, где ответил автомат, где ИИ-помощник
 * поддержки, а где живой человек. Помощник опознаётся по `meta.source`, а не
 * по роли: в БД он такой же `assistant`, как и приветствие Оплатишки.
 */
export function supportRoleLabel(
  role: string,
  staffName: string | null,
  meta?: Record<string, unknown> | null,
): string {
  if (role === 'user') return THREAD_ROLE_LABELS.user;
  if (role === 'operator') {
    return staffName ? `${THREAD_ROLE_LABELS.operator} · ${staffName}` : THREAD_ROLE_LABELS.operator;
  }
  if (role === 'assistant') {
    return meta?.source === SUPPORT_AI_META_SOURCE
      ? THREAD_ROLE_LABELS.assistantAi
      : THREAD_ROLE_LABELS.assistant;
  }
  if (role === 'system') return THREAD_ROLE_LABELS.system;
  return role;
}

/**
 * Служебная строка перехода режима — что показать менеджеру вместо сырого
 * `idle → ai`. `null` — это не строка перехода (обычный `system` без нашей
 * meta), показывать как есть.
 */
export function supportStateNote(meta: Record<string, unknown> | null | undefined): string | null {
  if (meta?.source !== SUPPORT_STATE_META_SOURCE) return null;
  const to = typeof meta.to === 'string' ? meta.to : null;
  const trigger = typeof meta.trigger === 'string' ? meta.trigger : null;
  const reason = typeof meta.reason === 'string' ? meta.reason : null;
  const actor = typeof meta.actor === 'string' ? meta.actor : null;
  const modeLabel = to ? (lookupLabel(SUPPORT_MODE_LABELS, to) ?? to) : '?';
  const parts = [`Режим: ${modeLabel}`];
  // Незнакомый триггер (строка из БД старше словаря) показывается как есть —
  // это лучше пустоты: менеджер хотя бы видит идентификатор.
  if (trigger) parts.push(lookupLabel(SUPPORT_TRIGGER_LABELS, trigger) ?? trigger);
  if (actor) parts.push(actor);
  if (reason) parts.push(reason);
  return parts.join(' · ');
}

/**
 * Кто вызвал переход — человеческим словом. Ключи — ВЕСЬ `ConversationModeTrigger`
 * (`satisfies`): новый триггер без подписи не соберётся, а не покажется сырым.
 */
const SUPPORT_TRIGGER_LABELS = {
  button: 'кнопка «Поддержка»',
  command: 'команда /support',
  deeplink: 'ссылка из приложения',
  hard: 'жёсткое слово',
  model: 'решение помощника',
  ai_unavailable: 'помощник недоступен',
  guard: 'выходной фильтр',
  ttl: 'истёк срок',
  cap: 'исчерпан лимит',
  start: 'клиент нажал /start',
  client: 'клиент завершил',
  ai_disabled: 'помощник выключен',
  operator_reply: 'ответ оператора',
  operator_claim: 'подключился оператор',
  operator_return: 'возврат помощнику',
  operator_close: 'закрыл оператор',
  auto: 'автозакрытие',
} as const satisfies Record<ConversationModeTrigger, string>;
