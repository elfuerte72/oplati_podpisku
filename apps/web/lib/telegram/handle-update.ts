import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { GrammyError, HttpError } from 'grammy';

import {
  appendMessage,
  getDb,
  getOrCreateActiveConversation,
  getOrCreateUserByTelegramId,
  loadRecentMessages,
  type MessageHistoryItem,
} from '@oplati/db';
import { GREETING, runAgent, runAgentNoTools } from '@oplati/agent';
import type { TelegramMessage, TelegramUpdate } from '@oplati/types';

import { childLogger } from '@/lib/logger';
import { createToolHandlers } from '@/lib/tool-handlers';

import { getBot } from './bot';

/**
 * Диспатч одиночного Telegram update.
 *
 * Поведение:
 *   - `/start` (с любыми deep-link payload'ами после пробела) → отправить
 *     `GREETING` из `@oplati/agent`. До отправки — upsert пользователя и
 *     conversation, append двух сообщений (user `/start` + assistant GREETING).
 *   - Любой другой текст → upsert + append user-сообщения → один round-trip
 *     `runAgentNoTools` → append assistant-ответа → отправить (с разбивкой 4096).
 *   - Всё остальное (медиа, callback, edited_message, channel_post) — лог
 *     `telegram.update.ignored` и тихо игнорируем (на этом milestone).
 *
 * Запись в БД — синхронная, до возврата 200 OK Telegram'у. Все ошибки БД
 * перехватываются в `persistInbound` / `appendMessage` (не пробрасываются),
 * поэтому падение Postgres не ломает webhook: AI-ответ всё равно уходит
 * (graceful degradation). История диалога в AI-context НЕ загружается из БД —
 * это аудит-лог; контекст AI расширим в milestone «State machine + AI tools».
 */

const log = childLogger('telegram-bot');
const dbLog = childLogger('db');

const TELEGRAM_MESSAGE_LIMIT = 4096;

type PersistContext = {
  userId: string;
  conversationId: string;
};

/**
 * Upsert пользователя и активного conversation для входящего Telegram-сообщения.
 * Возвращает `null` при отсутствии `from.id` (channel post / anonymous) или при
 * ошибке БД — caller продолжает работу без записи.
 */
async function persistInbound(
  update: TelegramUpdate,
  message: TelegramMessage,
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

    return { userId: user.id, conversationId: conversation.id };
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
async function safeAppendMessage(
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
        content,
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

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || message.text === undefined) {
    log.warn({ event: 'telegram.update.ignored', updateId: update.update_id, kind: 'no_text' });
    return;
  }

  const chatId = message.chat.id;
  const telegramUserId = message.from?.id;
  const text = message.text;

  if (text === '/start' || text.startsWith('/start ')) {
    log.info({
      event: 'telegram.start',
      chatId,
      telegramUserId,
      languageCode: message.from?.language_code,
    });

    const ctx = await persistInbound(update, message);
    if (ctx) {
      await safeAppendMessage(
        ctx,
        'user',
        text,
        {
          telegram_update_id: update.update_id,
          telegram_message_id: message.message_id,
        },
        update.update_id,
      );
      await safeAppendMessage(
        ctx,
        'assistant',
        GREETING,
        { source: 'static_greeting' },
        update.update_id,
      );
    }

    await sendSafely(chatId, GREETING, update.update_id);
    return;
  }

  log.info({
    event: 'telegram.message.user',
    updateId: update.update_id,
    chatId,
    telegramUserId,
    textLength: text.length,
  });

  const ctx = await persistInbound(update, message);
  if (ctx) {
    await safeAppendMessage(
      ctx,
      'user',
      text,
      {
        telegram_update_id: update.update_id,
        telegram_message_id: message.message_id,
      },
      update.update_id,
    );
  }

  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof runAgent>>;
  try {
    if (ctx) {
      // MVP-сценарий: search_catalog → propose_order → confirm_order. Без истории
      // AI забывает orderId из propose_order и не сможет вызвать confirm_order.
      // Подгружаем последние 20 user/assistant сообщений в хронологии. Текущее
      // user-сообщение уже записано в БД (safeAppendMessage выше), оно последнее.
      let history: MessageHistoryItem[] = [];
      try {
        history = await loadRecentMessages(getDb(), ctx.conversationId, 20, dbLog);
      } catch (err) {
        log.warn({
          event: 'telegram.history.load_failed',
          updateId: update.update_id,
          conversationId: ctx.conversationId,
          err,
        });
      }

      const agentHistory = toAgentHistory(history, text);
      const toolHandlers = createToolHandlers({ userId: ctx.userId, conversationId: ctx.conversationId });
      result = await runAgent(agentHistory, {
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        channel: 'telegram',
        toolHandlers,
      });
    } else {
      result = await runAgentNoTools([{ role: 'user', content: text }]);
    }
  } catch (err) {
    log.error({
      event: 'telegram.agent.failed',
      updateId: update.update_id,
      chatId,
      err,
    });
    Sentry.captureException(err, { tags: { source: 'telegram.bot' } });
    await sendSafely(
      chatId,
      'Сейчас не получается ответить — что-то на нашей стороне. Попробуй ещё раз через минуту или напиши «оператор», и я подключу человека.',
      update.update_id,
    );
    return;
  }

  const durationMs = Date.now() - startedAt;
  const replyText = result.text.trim();

  if (!replyText) {
    log.warn({
      event: 'telegram.message.ai_reply_empty',
      updateId: update.update_id,
      chatId,
      durationMs,
    });
    return;
  }

  log.info({
    event: 'telegram.message.ai_reply',
    updateId: update.update_id,
    chatId,
    durationMs,
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    totalTokens: result.usage.input_tokens + result.usage.output_tokens,
    replyLength: replyText.length,
  });

  if (ctx) {
    await safeAppendMessage(
      ctx,
      'assistant',
      replyText,
      {
        telegram_update_id: update.update_id,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
        },
      },
      update.update_id,
    );
  }

  for (const chunk of splitForTelegram(replyText, TELEGRAM_MESSAGE_LIMIT)) {
    await sendSafely(chatId, chunk, update.update_id);
  }
}

/**
 * Отправка с обработкой штатных ошибок (403 — заблокировал бота, 400 — bad
 * request на нашей стороне). Всё остальное — пробрасывается в Sentry, но
 * не пробрасывается дальше: webhook должен ответить 200.
 */
async function sendSafely(chatId: number, text: string, updateId: number): Promise<void> {
  try {
    await getBot().api.sendMessage(chatId, text);
  } catch (err) {
    if (err instanceof GrammyError) {
      if (err.error_code === 403) {
        log.warn({ event: 'telegram.send.blocked_by_user', updateId, chatId });
        return;
      }
      log.error({
        event: 'telegram.send.grammy_error',
        updateId,
        chatId,
        errorCode: err.error_code,
        description: err.description,
      });
      Sentry.captureException(err, { tags: { source: 'telegram.bot' } });
      return;
    }
    if (err instanceof HttpError) {
      log.error({ event: 'telegram.send.http_error', updateId, chatId, err });
      Sentry.captureException(err, { tags: { source: 'telegram.bot' } });
      return;
    }
    log.error({ event: 'telegram.send.unknown_error', updateId, chatId, err });
    Sentry.captureException(err, { tags: { source: 'telegram.bot' } });
  }
}

/**
 * Конвертирует историю из БД в формат Anthropic messages.
 *
 * - `user` / `assistant` идут как есть.
 * - `operator` мапится на `assistant` (для AI оператор = "от имени сервиса").
 * - `system` отбрасывается (если бы такие были).
 *
 * Anthropic требует чередования user/assistant и чтобы последнее сообщение было
 * user. Текущий вход (`currentUserText`) уже записан в БД через safeAppendMessage
 * перед этим вызовом, так что он должен быть последним user в `history`.
 * На всякий случай — если последнее сообщение не user или history пуст, добавляем
 * currentUserText явно.
 *
 * Также сжимаем последовательные одинаковые роли в одно сообщение (объединяем
 * через \n\n) — Anthropic ругается на consecutive same-role messages.
 */
function toAgentHistory(
  history: MessageHistoryItem[],
  currentUserText: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const mapped = history
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'operator')
    .map((m) => ({
      role: (m.role === 'operator' ? 'assistant' : m.role) as 'user' | 'assistant',
      content: m.content,
    }));

  // Сжимаем consecutive same-role.
  const collapsed: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of mapped) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else {
      collapsed.push({ ...m });
    }
  }

  // Гарантируем что последнее сообщение — user.
  const last = collapsed[collapsed.length - 1];
  if (!last || last.role !== 'user') {
    collapsed.push({ role: 'user', content: currentUserText });
  }

  return collapsed;
}

/**
 * Режем длинный ответ AI на куски ≤ `limit`. Сначала пытаемся по границам
 * абзацев и строк, чтобы не разрывать смысл; если кусок всё равно слишком
 * большой — режем по символам.
 */
export function splitForTelegram(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const result: string[] = [];
  let buffer = '';

  for (const line of text.split('\n')) {
    const candidate = buffer ? `${buffer}\n${line}` : line;
    if (candidate.length <= limit) {
      buffer = candidate;
      continue;
    }
    if (buffer) {
      result.push(buffer);
      buffer = '';
    }
    if (line.length <= limit) {
      buffer = line;
      continue;
    }
    for (let i = 0; i < line.length; i += limit) {
      result.push(line.slice(i, i + limit));
    }
  }
  if (buffer) result.push(buffer);
  return result;
}
