import 'server-only';

import type { TelegramMessage, TelegramUpdate } from '@oplati/types';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { supportPorts, type SupportRequestContext } from '@/lib/support/adapters';
import {
  closeSupportSession,
  handleSupportMessage,
  openSupportSession,
  type OpenSupportResult,
  type SupportOutcome,
} from '@/lib/support/session';
import type { SupportSurface } from '@/lib/support/ports';
import { SUPPORT_MEDIA_PLACEHOLDER } from '@/lib/support/texts';

import type { PersistContext } from './persist';

/**
 * Мост между ботом и модулем поддержки: собирает контекст запроса и
 * переводит исход модуля в решение бота.
 *
 * Логики поддержки здесь НЕТ — она вся в `lib/support/session.ts`. Здесь только
 * то, что знает бот: chat_id, update_id, кто написал.
 */

const log = childLogger('telegram-bot');

/** Включён ли помощник. Выключен — работает сегодняшний флоу к человеку. */
export function isSupportAiEnabled(): boolean {
  return serverEnv.SUPPORT_AI_ENABLED;
}

function contextOf(
  ctx: PersistContext,
  chatId: number,
  updateId: number,
  from: TelegramMessage['from'],
): SupportRequestContext {
  return {
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    chatId,
    telegramId: from?.id ?? chatId,
    updateId,
    displayName: from?.first_name ?? null,
    username: from?.username ?? null,
  };
}

/** Вход в поддержку: кнопка, `/support`, deep-link. */
export async function openSupportFromBot(
  ctx: PersistContext,
  chatId: number,
  updateId: number,
  from: TelegramMessage['from'],
  surface: SupportSurface,
): Promise<OpenSupportResult> {
  const ports = supportPorts(contextOf(ctx, chatId, updateId, from));
  const result = await openSupportSession(ports, { surface });
  log.info({ event: 'telegram.support.session_open', chatId, surface, status: result.status });
  return result;
}

/**
 * Свободный текст или медиа внутри разговора.
 *
 * Возвращает исход, чтобы вызывающий решил, что делать дальше: подсказка при
 * `not_in_session`, сегодняшний флоу при недоступной БД, тишина при живом
 * операторе.
 */
export async function routeSupportIncoming(
  ctx: PersistContext,
  chatId: number,
  update: TelegramUpdate,
  message: TelegramMessage,
  input: {
    text: string;
    kind: 'text' | 'media';
    mediaKind?: 'photo' | 'file';
    userMeta?: Record<string, unknown>;
  },
): Promise<SupportOutcome> {
  const ports = supportPorts(contextOf(ctx, chatId, update.update_id, message.from));
  const outcome = await handleSupportMessage(ports, {
    text: input.text,
    kind: input.kind,
    ...(input.userMeta ? { userMeta: input.userMeta } : {}),
    ...(input.kind === 'media'
      ? { mediaPlaceholder: SUPPORT_MEDIA_PLACEHOLDER[input.mediaKind ?? 'file'] }
      : {}),
  });
  log.info({
    event: 'telegram.support.incoming',
    chatId,
    kind: input.kind,
    outcome: outcome.status,
  });
  return outcome;
}

/** Кнопка «Завершить» под ответом помощника. */
export async function finishSupportFromBot(
  ctx: PersistContext,
  chatId: number,
  updateId: number,
  telegramId: number,
): Promise<void> {
  const ports = supportPorts({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    chatId,
    telegramId,
    updateId,
  });
  await closeSupportSession(ports, { reason: 'client' });
}

/**
 * `/start` сбрасывает помощника.
 *
 * Молча: клиент сам ушёл в меню, и «диалог завершён» вдогонку спорит с его же
 * действием. Разговор, который ведёт человек, не трогается — это решает
 * оператор, а не команда клиента.
 */
export async function resetSupportOnStart(
  ctx: PersistContext,
  chatId: number,
  updateId: number,
  telegramId: number,
): Promise<void> {
  const ports = supportPorts({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    chatId,
    telegramId,
    updateId,
  });
  await closeSupportSession(ports, { reason: 'start', silent: true });
}
