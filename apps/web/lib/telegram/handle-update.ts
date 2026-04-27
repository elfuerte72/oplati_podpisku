import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { GrammyError, HttpError } from 'grammy';

import { runAgentNoTools, GREETING } from '@oplati/agent';
import type { TelegramUpdate } from '@oplati/types';

import { childLogger } from '@/lib/logger';

import { getBot } from './bot';

/**
 * Диспатч одиночного Telegram update.
 *
 * Поведение:
 *   - `/start` (с любыми deep-link payload'ами после пробела) → отправить
 *     `GREETING` из `@oplati/agent`.
 *   - Любой другой текст → один round-trip через `runAgentNoTools` →
 *     отправить ответ. Если ответ длиннее 4096 символов (лимит Telegram) —
 *     режем по границам строк, при необходимости — посимвольно.
 *   - Всё остальное (медиа, callback, edited_message, channel_post) — лог
 *     `telegram.update.ignored` и тихо игнорируем (на этом milestone).
 *
 * Stateless: история диалога не хранится. Появится в milestone «Базовая
 * схема БД» (`messages` table).
 */

const log = childLogger('telegram-bot');

const TELEGRAM_MESSAGE_LIMIT = 4096;

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

  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof runAgentNoTools>>;
  try {
    result = await runAgentNoTools([{ role: 'user', content: text }]);
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
