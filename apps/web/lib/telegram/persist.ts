import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  appendMessage,
  getDb,
  getLastAssistantMessageMeta,
  getOrCreateActiveConversation,
  getOrCreateUserByTelegramId,
} from '@oplati/db';
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from '@oplati/types';

import { childLogger } from '@/lib/logger';

import { redactCardNumbers } from './templates';

/**
 * Персист входящих Telegram-апдейтов: upsert user/conversation + запись строк
 * диалога (выделено из handle-update.ts при распиле M-10, поведение 1:1).
 *
 * Все ошибки БД перехватываются здесь (лог + Sentry, наружу `null`/`false`) —
 * падение Postgres не ломает webhook: бот отвечает, но «забывает» историю
 * (graceful degradation, см. CLAUDE.md).
 */

const log = childLogger('telegram-bot');
const dbLog = childLogger('db');

export type PersistContext = {
  userId: string;
  conversationId: string;
  /**
   * Строка `users` создана ЭТИМ апдейтом (`xmax = 0` в upsert'е). Нужен
   * `/start ref_`: у только что созданной строки реферер уже проставлен INSERT'ом,
   * и поздний захват ей не нужен — зато нужно сказать другу и партнёру, что
   * приглашение сработало. У контекстов, собранных не из persistInbound
   * (callback-и), поля нет.
   */
  userCreated?: boolean;
};

/**
 * Upsert пользователя и активного conversation для входящего Telegram-сообщения.
 * Возвращает `null` при отсутствии `from.id` (channel post / anonymous) или при
 * ошибке БД — caller продолжает работу без записи.
 */
export async function persistInbound(
  update: TelegramUpdate,
  message: TelegramMessage,
  opts?: { referredBy?: string | null },
): Promise<PersistContext | null> {
  if (!message.from?.id) {
    log.warn({
      event: 'telegram.persist.skipped',
      updateId: update.update_id,
      reason: 'no_from_id',
    });
    return null;
  }

  const startedAt = Date.now();
  const telegramId = String(message.from.id);
  const displayNameParts = [message.from.first_name, message.from.last_name].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  const displayName = displayNameParts.length > 0 ? displayNameParts.join(' ') : null;

  log.info({
    event: 'telegram.persist.start',
    updateId: update.update_id,
    chatId: message.chat.id,
  });

  try {
    const db = getDb();
    const user = await getOrCreateUserByTelegramId(
      db,
      {
        telegramId,
        displayName,
        language: message.from.language_code ?? 'ru',
        // referred_by ставится только при создании строки (см. репозиторий);
        // для не-/start апдейтов opts отсутствует → реферер не трогается.
        referredBy: opts?.referredBy ?? null,
      },
      dbLog,
    );
    const conversation = await getOrCreateActiveConversation(
      db,
      { userId: user.id, channel: 'telegram' },
      dbLog,
    );

    log.info({
      event: 'telegram.persist.done',
      updateId: update.update_id,
      userId: user.id,
      conversationId: conversation.id,
      userCreated: user.created,
      conversationCreated: conversation.created,
      durationMs: Date.now() - startedAt,
    });

    return { userId: user.id, conversationId: conversation.id, userCreated: user.created };
  } catch (err) {
    log.error({
      event: 'telegram.persist.failed',
      updateId: update.update_id,
      durationMs: Date.now() - startedAt,
      err,
    });
    Sentry.captureException(err, { tags: { source: 'telegram.persist' } });
    return null;
  }
}

/**
 * Добавить строку в `messages`. Ошибки БД глотаются (логируем + Sentry), чтобы
 * один сбой записи не ломал webhook. Возвращает `true`, если строка записана.
 */
export async function safeAppendMessage(
  ctx: PersistContext,
  role: 'user' | 'assistant',
  content: string,
  meta: Record<string, unknown> | null,
  updateId: number,
): Promise<boolean> {
  try {
    await appendMessage(
      getDb(),
      {
        conversationId: ctx.conversationId,
        role,
        // PAN-подобные последовательности маскируются НА ГРАНИЦЕ ЗАПИСИ
        // (находка ревью 2026-08-11). Маскировать только в DM оператору было
        // недостаточно: тот же текст клиента попадал в `messages.content`
        // целиком — а это 90 дней хранения, бэкапы в R2 и подмешивание
        // в историю запроса к Anthropic. Номер карты не нужен ни одному
        // потребителю этой таблицы.
        content: redactCardNumbers(content),
        meta,
      },
      dbLog,
    );
    return true;
  } catch (err) {
    log.error({
      event: 'telegram.persist.message_failed',
      updateId,
      conversationId: ctx.conversationId,
      role,
      err,
    });
    Sentry.captureException(err, {
      tags: { source: 'telegram.persist', step: 'appendMessage' },
    });
    return false;
  }
}

/**
 * Резолвит пользователя и активный conversation по нажавшему кнопку
 * (`cb.from` обязателен по схеме). Нужен для записи pending-state и создания
 * заказа. `null` при недоступной БД — caller деградирует.
 */
export async function resolveCallbackContext(
  cb: TelegramCallbackQuery,
  updateId: number,
): Promise<PersistContext | null> {
  try {
    const db = getDb();
    const nameParts = [cb.from.first_name, cb.from.last_name].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    const user = await getOrCreateUserByTelegramId(
      db,
      {
        telegramId: String(cb.from.id),
        displayName: nameParts.length > 0 ? nameParts.join(' ') : null,
        language: cb.from.language_code ?? 'ru',
      },
      dbLog,
    );
    const conversation = await getOrCreateActiveConversation(
      db,
      { userId: user.id, channel: 'telegram' },
      dbLog,
    );
    return { userId: user.id, conversationId: conversation.id };
  } catch (err) {
    log.error({ event: 'telegram.callback.resolve_ctx_failed', updateId, err });
    Sentry.captureException(err, { tags: { source: 'telegram.callback', step: 'resolve_ctx' } });
    return null;
  }
}

/**
 * Читает pending-state — meta последнего assistant-сообщения диалога. Сбой чтения
 * не должен блокировать обычный путь, поэтому возвращаем `null` (ожиданий нет).
 */
export async function readPendingMeta(
  conversationId: string,
  updateId: number,
): Promise<Record<string, unknown> | null> {
  try {
    return await getLastAssistantMessageMeta(getDb(), conversationId, dbLog);
  } catch (err) {
    log.warn({ event: 'telegram.pending_meta.failed', updateId, err });
    return null;
  }
}
