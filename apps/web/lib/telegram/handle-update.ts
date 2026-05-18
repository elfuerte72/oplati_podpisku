import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { GrammyError, HttpError } from 'grammy';

import {
  appendMessage,
  getDb,
  getOrCreateActiveConversation,
  getOrCreateUserByTelegramId,
  getOrderById,
  loadRecentMessages,
  transitionOrder,
  type MessageHistoryItem,
} from '@oplati/db';
import { GREETING, runAgent, runAgentNoTools, type ProposeOrderResult, type ToolCallLog } from '@oplati/agent';
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from '@oplati/types';
import { InlineKeyboard } from 'grammy';

import { childLogger } from '@/lib/logger';
import { createToolHandlers } from '@/lib/tool-handlers';
import { confirmOrder } from '@/lib/tool-handlers/confirm-order';

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
  // Inline-кнопки приходят как callback_query (не message). Обрабатываем отдельной веткой.
  if (update.callback_query) {
    await handleCallbackQuery(update, update.callback_query);
    return;
  }

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
      const noToolsResult = await runAgentNoTools([{ role: 'user', content: text }]);
      result = { ...noToolsResult, toolCalls: [] };
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

  // Если последним tool'ом был успешный propose_order — приклеиваем к ответу
  // кнопки «Подтвердить»/«Отменить» вместо текстового вопроса.
  const proposeResult = extractProposeOrderResult(result.toolCalls);
  const chunks = splitForTelegram(replyText, TELEGRAM_MESSAGE_LIMIT);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] ?? '';
    const isLast = i === chunks.length - 1;
    if (isLast && proposeResult) {
      await sendSafely(chatId, chunk, update.update_id, buildConfirmKeyboard(proposeResult.orderId));
    } else {
      await sendSafely(chatId, chunk, update.update_id);
    }
  }
}

/**
 * Достаёт результат последнего успешного `propose_order` вызова из лога tool calls
 * (после propose_order может ещё что-то быть, но кнопки делаем по самому свежему).
 */
function extractProposeOrderResult(toolCalls: ToolCallLog[]): ProposeOrderResult | null {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const call = toolCalls[i];
    if (!call) continue;
    if (call.name === 'propose_order' && !call.isError) {
      const out = call.output;
      if (
        typeof out === 'object' && out !== null &&
        'orderId' in out && typeof (out as { orderId: unknown }).orderId === 'string'
      ) {
        return out as ProposeOrderResult;
      }
    }
  }
  return null;
}

function buildConfirmKeyboard(orderId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Подтвердить', `confirm:${orderId}`)
    .text('Отменить', `cancel:${orderId}`);
}

/**
 * Обработчик нажатия inline-кнопок «Подтвердить» / «Отменить».
 *
 * callback_data:
 *   - `confirm:<orderId>` → вызывает confirmOrder (создание L&P invoice) и
 *      отправляет пользователю ссылку оплаты.
 *   - `cancel:<orderId>`  → transitionOrder → cancelled, шлёт «Заказ отменён».
 *
 * Telegram требует ответить на callback_query через `answerCallbackQuery` —
 * иначе кнопка будет крутиться у пользователя до таймаута (~15s).
 */
async function handleCallbackQuery(
  update: TelegramUpdate,
  cb: TelegramCallbackQuery,
): Promise<void> {
  const chatId = cb.message?.chat.id;
  const updateId = update.update_id;
  const data = cb.data ?? '';
  const [action, orderId] = data.split(':');

  log.info({
    event: 'telegram.callback.received',
    updateId,
    chatId,
    action,
    hasOrderId: Boolean(orderId),
  });

  // Сразу подтверждаем callback (Telegram перестанет крутить кнопку).
  try {
    await getBot().api.answerCallbackQuery(cb.id);
  } catch (err) {
    log.warn({ event: 'telegram.callback.answer_failed', updateId, err });
  }

  if (!chatId || !orderId || (action !== 'confirm' && action !== 'cancel')) {
    log.warn({ event: 'telegram.callback.invalid', updateId, data });
    return;
  }

  // Снимем кнопки у исходного сообщения — нельзя нажать дважды.
  if (cb.message) {
    try {
      await getBot().api.editMessageReplyMarkup(chatId, cb.message.message_id);
    } catch (err) {
      log.debug({ event: 'telegram.callback.unmark_failed', updateId, err });
    }
  }

  if (action === 'confirm') {
    let confirmResult: Awaited<ReturnType<typeof confirmOrder>>;
    try {
      confirmResult = await confirmOrder({ orderId });
    } catch (err) {
      log.error({ event: 'telegram.callback.confirm.failed', updateId, orderId, err });
      Sentry.captureException(err, {
        tags: { source: 'telegram.callback', step: 'confirm' },
        extra: { orderId },
      });
      await sendSafely(
        chatId,
        'Не получилось создать счёт прямо сейчас — техническая проблема на стороне платёжного провайдера. Я уже подключил оператора, он напишет в ближайшее время.',
        updateId,
      );
      return;
    }

    const replyParts = [`Счёт готов. Оплата:\n${confirmResult.paymentUrl}`];
    if (confirmResult.qrPayload) {
      replyParts.push('Или отсканируй QR-код в приложении банка по СБП.');
    }
    replyParts.push(`Счёт действует до ${formatExpires(confirmResult.expiresAt)}.`);
    const reply = replyParts.join('\n\n');

    await sendSafely(chatId, reply, updateId);
    return;
  }

  // action === 'cancel'
  try {
    const db = getDb();
    const order = await getOrderById(db, orderId);
    if (!order) {
      await sendSafely(chatId, 'Заказ уже не найден. Если хочешь начать заново — напиши /start.', updateId);
      return;
    }
    // cancel валиден только из draft/clarifying/ready_for_payment/pending_payment.
    // Если order уже paid/in_fulfillment/etc — transitionOrder бросит OrderTransitionError.
    await transitionOrder(db, {
      orderId,
      toStatus: 'cancelled',
      actorType: 'user',
      eventType: 'user_cancelled',
      payload: { source: 'telegram_inline_button' },
    });
    await sendSafely(chatId, 'Заказ отменён. Если передумаешь — напиши /start.', updateId);
  } catch (err) {
    log.error({ event: 'telegram.callback.cancel.failed', updateId, orderId, err });
    Sentry.captureException(err, {
      tags: { source: 'telegram.callback', step: 'cancel' },
      extra: { orderId },
    });
    await sendSafely(chatId, 'Не получилось отменить заказ. Напиши «оператор», подключу человека.', updateId);
  }
}

function formatExpires(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'long' });
  } catch {
    return iso;
  }
}

/**
 * Отправка с обработкой штатных ошибок (403 — заблокировал бота, 400 — bad
 * request на нашей стороне). Всё остальное — пробрасывается в Sentry, но
 * не пробрасывается дальше: webhook должен ответить 200.
 */
async function sendSafely(
  chatId: number,
  text: string,
  updateId: number,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  try {
    await getBot().api.sendMessage(chatId, text, replyMarkup ? { reply_markup: replyMarkup } : undefined);
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
