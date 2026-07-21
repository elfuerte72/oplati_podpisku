import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { GrammyError, HttpError } from 'grammy';
import type { InlineKeyboard } from 'grammy';

import { childLogger } from '@/lib/logger';

import { getBot } from './bot';

/**
 * Отправка сообщений в Telegram: безопасный send, edit-or-send, индикатор
 * «печатает…», разбивка длинных ответов (выделено из handle-update.ts при
 * распиле M-10, поведение 1:1).
 */

const log = childLogger('telegram-bot');

export const TELEGRAM_MESSAGE_LIMIT = 4096;
const TYPING_REFRESH_MS = 4000;

/**
 * Показывает «печатает…» пользователю на всё время выполнения `fn`.
 * Telegram сам гасит индикатор через 5 сек, поэтому повторяем каждые 4 сек.
 * Ошибки sendChatAction не критичны — глотаем, чтобы не валить основной flow.
 */
export async function withTypingIndicator<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
  const api = getBot().api;
  void api.sendChatAction(chatId, 'typing').catch(() => undefined);
  const interval = setInterval(() => {
    void api.sendChatAction(chatId, 'typing').catch(() => undefined);
  }, TYPING_REFRESH_MS);
  try {
    return await fn();
  } finally {
    clearInterval(interval);
  }
}

/**
 * Отправка с обработкой штатных ошибок (403 — заблокировал бота, 400 — bad
 * request на нашей стороне). Всё остальное — пробрасывается в Sentry, но
 * не пробрасывается дальше: webhook должен ответить 200.
 */
export async function sendSafely(
  chatId: number,
  text: string,
  updateId: number,
  replyMarkup?: InlineKeyboard,
  opts?: { parseMode?: 'HTML' },
): Promise<void> {
  try {
    const other = {
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
    };
    await getBot().api.sendMessage(
      chatId,
      text,
      Object.keys(other).length > 0 ? other : undefined,
    );
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
 * Показать сообщение: редактирует существующее (`messageId` задан — навигация
 * по inline-кнопке, ощущение «экрана» как на сайте) либо отправляет новое
 * (`messageId` нет — /menu, ошибки в текстовом флоу). На edit-методах Telegram
 * пропущенный `reply_markup` снимает старую клавиатуру — то, что нужно при
 * переходе на текстовый экран. «message is not modified» — игнор; прочий сбой
 * edit (старое/удалённое сообщение) — fallback на отправку нового.
 */
export async function showOrEdit(
  chatId: number,
  messageId: number | undefined,
  text: string,
  updateId: number,
  keyboard?: InlineKeyboard,
): Promise<void> {
  if (messageId === undefined) {
    await sendSafely(chatId, text, updateId, keyboard);
    return;
  }
  try {
    await getBot().api.editMessageText(
      chatId,
      messageId,
      text,
      keyboard ? { reply_markup: keyboard } : {},
    );
  } catch (err) {
    if (err instanceof GrammyError && /not modified/i.test(err.description)) {
      return;
    }
    log.debug({ event: 'telegram.callback.edit_failed', updateId, err });
    await sendSafely(chatId, text, updateId, keyboard);
  }
}

/**
 * Разбивает текст на атомы для splitForTelegram:
 *   - каждая обычная строка — отдельный атом;
 *   - блок кода между парой строк ```...``` — один атом целиком,
 *     чтобы граница чанка не прошла внутри кода.
 *
 * Незакрытый ```-блок отдаётся как один большой атом (защита от моделей,
 * забывших закрыть fence).
 */
function tokenizeForSplit(text: string): string[] {
  const tokens: string[] = [];
  let inCode = false;
  let buf: string[] = [];
  for (const line of text.split('\n')) {
    const isFence = line.startsWith('```');
    if (isFence) {
      if (!inCode) {
        inCode = true;
        buf = [line];
      } else {
        buf.push(line);
        tokens.push(buf.join('\n'));
        buf = [];
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      buf.push(line);
    } else {
      tokens.push(line);
    }
  }
  if (buf.length > 0) tokens.push(buf.join('\n'));
  return tokens;
}

/**
 * Режем длинный ответ AI на куски ≤ `limit`. Сначала пытаемся по границам
 * строк и code-блоков, чтобы не разрывать смысл; если атом всё равно слишком
 * большой (длинный код или строка без \n) — режем по символам.
 */
export function splitForTelegram(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const result: string[] = [];
  let buffer = '';

  for (const token of tokenizeForSplit(text)) {
    const candidate = buffer ? `${buffer}\n${token}` : token;
    if (candidate.length <= limit) {
      buffer = candidate;
      continue;
    }
    if (buffer) {
      result.push(buffer);
      buffer = '';
    }
    if (token.length <= limit) {
      buffer = token;
      continue;
    }
    for (let i = 0; i < token.length; i += limit) {
      result.push(token.slice(i, i + limit));
    }
  }
  if (buffer) result.push(buffer);
  return result;
}
