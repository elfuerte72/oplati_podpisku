import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, loadRecentMessages, type MessageHistoryItem } from '@oplati/db';
import {
  classifyMessage,
  runAgent,
  runAgentNoTools,
  type AgentMessage,
  type ProposeOrderResult,
  type RouteDecision,
  type RouteKind,
  type ToolCallLog,
} from '@oplati/agent';
import type { TelegramUpdate } from '@oplati/types';

import {
  BUDGET_EXCEEDED_TEXT,
  isAiBudgetExceeded,
  mergeUsage,
  recordAgentUsage,
  type AgentUsageLike,
} from '@/lib/ai/budget';
import { toAgentHistory } from '@/lib/chat/history';
import { childLogger } from '@/lib/logger';
import { createToolHandlers } from '@/lib/tool-handlers';

import { buildConfirmKeyboard } from './catalog-callbacks';
import { safeAppendMessage, type PersistContext } from './persist';
import { sendSafely, splitForTelegram, TELEGRAM_MESSAGE_LIMIT, withTypingIndicator } from './send';

/**
 * AI-диалог с Оплатишкой в чате бота: токен-бюджет → Haiku-роутер → runAgent
 * (tools) → учёт usage → ответ с разбивкой 4096 и кнопками заказа (выделено из
 * handle-update.ts при распиле M-10, поведение 1:1). Вызывается роутером только
 * при BOT_AI_ENABLED=1.
 */

const log = childLogger('telegram-bot');
const dbLog = childLogger('db');

export async function runAgentDialog(
  update: TelegramUpdate,
  chatId: number,
  text: string,
  ctx: PersistContext | null,
): Promise<void> {
  // Дневной глобальный токен-бюджет (как в /api/chat): при превышении —
  // заготовленный ответ без единого вызова Anthropic.
  if (await isAiBudgetExceeded()) {
    log.warn({ event: 'telegram.budget_exceeded', updateId: update.update_id, chatId });
    if (ctx) {
      await safeAppendMessage(
        ctx,
        'assistant',
        BUDGET_EXCEEDED_TEXT,
        { source: 'budget_guard' },
        update.update_id,
      );
    }
    await sendSafely(chatId, BUDGET_EXCEEDED_TEXT, update.update_id);
    return;
  }

  const startedAt = Date.now();
  let routedAs: RouteKind = 'agent';
  let routerUsage: AgentUsageLike | null = null;
  let result: Awaited<ReturnType<typeof runAgent>>;
  try {
    result = await withTypingIndicator(chatId, async () => {
      // MVP-сценарий: search_catalog → propose_order → confirm_order. Без истории
      // AI забывает orderId из propose_order и не сможет вызвать confirm_order.
      // Подгружаем последние 20 user/assistant сообщений в хронологии. Текущее
      // user-сообщение уже записано в БД (safeAppendMessage выше), оно последнее.
      let agentHistory: AgentMessage[] = [{ role: 'user', content: text }];
      if (ctx) {
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
        agentHistory = toAgentHistory(history, text);
      }

      // Haiku-роутер: приветствие/оффтоп/инъекция → каннед-ответ без Sonnet.
      // Fail-open: упавший классификатор не блокирует агента.
      let route: RouteDecision = { route: 'agent', usage: null };
      try {
        route = await classifyMessage(agentHistory);
      } catch (err) {
        log.warn({ event: 'telegram.router_failed', updateId: update.update_id, err });
        Sentry.captureException(err, { tags: { source: 'telegram.router' } });
      }
      routerUsage = route.usage;

      if (route.route !== 'agent') {
        routedAs = route.route;
        // usage роутера уйдёт в счётчик как result.usage — не учитывать дважды
        routerUsage = null;
        return { text: route.cannedText, usage: route.usage, toolCalls: [] };
      }

      if (ctx) {
        const toolHandlers = createToolHandlers({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
        });
        return runAgent(agentHistory, {
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          channel: 'telegram',
          toolHandlers,
        });
      }
      const noToolsResult = await runAgentNoTools(agentHistory);
      return { ...noToolsResult, toolCalls: [] };
    });
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

  // Дневной счётчик: usage агента + Haiku-роутера (при каннед-ответе роутер уже в result).
  await recordAgentUsage(mergeUsage(routerUsage, result.usage));

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
    // 'agent' — обычный путь; greeting/offtopic/injection — каннед без Sonnet
    routedAs,
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    totalTokens: result.usage.input_tokens + result.usage.output_tokens,
    // Prompt caching: read > 0 — префикс tools+system пришёл из кэша (~0.1x цены)
    cacheReadTokens: result.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: result.usage.cache_creation_input_tokens ?? 0,
    webSearchRequests: result.usage.server_tool_use?.web_search_requests ?? 0,
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
