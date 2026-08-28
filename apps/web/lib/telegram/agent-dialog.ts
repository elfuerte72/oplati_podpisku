import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, loadRecentMessages, type MessageHistoryItem } from '@oplati/db';
import {
  AgentLoopError,
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

import { supportPorts } from '@/lib/support/adapters';
import { isSupportAiEnabled, supportRequestContext } from './support-session';
import { escalate } from '@/lib/support/session';

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

/**
 * Текст, когда AI недоступен.
 *
 * Намеренно НЕ копия веб-чатовского (`/api/chat`): тот зовёт написать
 * «оператор», а в боте это слово не обрабатывает ничто — текстовый путь знает
 * только `/start`, `/support`, pending-флоу и подписи кнопок, так что совет
 * возвращал бы клиента в тот же сломанный AI-путь по кругу (ревью 2026-08-11).
 * Здесь называем ровно ту дверь к человеку, которая работает без AI.
 */
const AI_DOWN_TEXT =
  'Сейчас не получается ответить — что-то на нашей стороне. Попробуй ещё раз через минуту, ' +
  'а если нужен человек — напиши /support, и я передам обращение оператору.';

/** Взведён ли уже алёрт о пропавшем ключе — один раз на процесс. */
let missingKeyAlerted = false;

/**
 * Отправить заготовленный ответ И записать его в историю.
 *
 * Запись обязательна (ревью 2026-08-11): входящие сообщения пишутся всегда, и
 * ветка, ответившая без записи, оставляет в диалоге подряд идущие `user`-строки.
 * `toAgentHistory` схлопывает их в ОДИН ход, и после восстановления AI агент
 * отвечает на слипшийся комок старых намерений — вплоть до `propose_order` на
 * сервис, о котором спрашивали три сообщения назад.
 */
async function replyAndRemember(
  update: TelegramUpdate,
  chatId: number,
  ctx: PersistContext | null,
  text: string,
  source: string,
): Promise<void> {
  if (ctx) {
    await safeAppendMessage(ctx, 'assistant', text, { source }, update.update_id);
  }
  await sendSafely(chatId, text, update.update_id);
}

export async function runAgentDialog(
  update: TelegramUpdate,
  chatId: number,
  text: string,
  ctx: PersistContext | null,
): Promise<void> {
  // Нет ключа Anthropic — деградируем ЗДЕСЬ, на AI-пути, а не выключением
  // всего бота в роуте (аудит 2026-08-10): кнопочные и платёжные флоу к
  // Anthropic отношения не имеют. Без этого гейта каждое сообщение уходило бы
  // в `getClient()`, падало исключением и сыпало Sentry — при том же тексте
  // клиенту. Зеркалит гейт `/api/chat`.
  if (!process.env.ANTHROPIC_API_KEY) {
    log.error({ event: 'telegram.ai_disabled', reason: 'no_anthropic_key', chatId });
    // Алёрт, а не только лог: раньше пропажу ключа было видно сразу (бот
    // замолкал целиком), теперь бот работает и молчит об этом только AI-путь —
    // конфиг мог бы протухать незамеченным (ревью 2026-08-11). Один раз на
    // процесс: смысл в факте, а не в количестве.
    if (!missingKeyAlerted) {
      missingKeyAlerted = true;
      Sentry.captureMessage('Bot AI enabled, but ANTHROPIC_API_KEY is not set', {
        level: 'error',
        tags: { source: 'telegram.bot' },
      });
    }
    await replyAndRemember(update, chatId, ctx, AI_DOWN_TEXT, 'ai_unavailable');
    return;
  }

  // Дневной глобальный токен-бюджет (как в /api/chat): при превышении —
  // заготовленный ответ без единого вызова Anthropic.
  if (await isAiBudgetExceeded()) {
    log.warn({ event: 'telegram.budget_exceeded', updateId: update.update_id, chatId });
    await replyAndRemember(update, chatId, ctx, BUDGET_EXCEEDED_TEXT, 'budget_guard');
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
        return { text: route.cannedText, usage: route.usage, toolCalls: [], incomplete: false };
      }

      if (ctx) {
        const toolHandlers = createToolHandlers({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          // «Позвать оператора» у продажного агента — тот же механизм, что у
          // помощника поддержки: переход разговора в `operator` + уведомление
          // персонала. Иначе включение `BOT_AI_ENABLED` оживило бы путь, где
          // команда никого не зовёт.
          // ⚠️ Только при включённом помощнике: без него режим `operator`
          // некому снять — панельные кнопки есть, но клиент до них не
          // достучится, и одна команда модели запирала бы разговор навсегда.
          ...(isSupportAiEnabled()
            ? {
                escalateToHuman: async (reason: string) => {
                  const ports = supportPorts(
                    supportRequestContext(ctx, chatId, update.update_id, update.message?.from),
                  );
                  await escalate(ports, { trigger: 'model', reason });
                },
              }
            : {}),
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
    // Токены, потраченные до сбоя, уже списаны провайдером — записываем их в
    // дневной бюджет (аудит 2026-08-10). Иначе самые дорогие запросы (несколько
    // итераций tool-loop, упавших на последней) стоили бюджету ноль, и защита
    // расходов слепла ровно на том, от чего защищает.
    if (err instanceof AgentLoopError) {
      await recordAgentUsage(mergeUsage(routerUsage, err.usage));
      // Что цикл успел сделать до сбоя — это факты о деньгах: среди них может
      // быть созданный заказ или выставленный счёт. Молча выбросить их нельзя,
      // иначе против заказа клиента висит инвойс, о котором никто не знает.
      await reportAbandonedToolCalls(err, update.update_id, chatId);
    }
    await replyAndRemember(update, chatId, ctx, AI_DOWN_TEXT, 'ai_unavailable');
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
  //
  // ⚠️ Только к ЗАВЕРШЁННОМУ ответу. Когда модель оборвалась на `max_tokens`
  // или отказалась, текст служебный и суммы в нём нет — кнопка «Подтвердить»
  // под таким сообщением выставляет реальный счёт на цену, которую клиент не
  // видел (ревью 2026-08-11).
  const proposeResult = result.incomplete ? null : extractProposeOrderResult(result.toolCalls);
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
 * Сообщает наружу о побочных действиях, оставшихся после сбоя tool-loop.
 *
 * Успешный `confirm_order` означает выставленный счёт с живой платёжной
 * ссылкой: клиенту она нужна, иначе он получит «AI недоступен», а через час
 * инвойс протухнет. Успешный `propose_order` (без confirm) денег не двигает —
 * его достаточно зафиксировать в наблюдаемости.
 */
async function reportAbandonedToolCalls(
  err: AgentLoopError,
  updateId: number,
  chatId: number,
): Promise<void> {
  const succeeded = err.toolCalls.filter((c) => !c.isError).map((c) => c.name);
  if (succeeded.length === 0) return;

  log.error({
    event: 'telegram.agent.tool_calls_abandoned',
    updateId,
    chatId,
    reason: err.reason,
    toolCalls: succeeded,
  });
  Sentry.captureMessage('Agent loop failed after side effects', {
    level: 'error',
    tags: { source: 'telegram.bot' },
    extra: { updateId, reason: err.reason, toolCalls: succeeded },
  });

  const confirmed = extractConfirmOrderResult(err.toolCalls);
  if (confirmed) {
    await sendSafely(
      chatId,
      `Счёт уже выставлен — ссылка на оплату: ${confirmed.paymentUrl}`,
      updateId,
    );
  }
}

/** Последний успешный `confirm_order` из лога вызовов. */
function extractConfirmOrderResult(toolCalls: ToolCallLog[]): { paymentUrl: string } | null {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const call = toolCalls[i];
    if (!call || call.name !== 'confirm_order' || call.isError) continue;
    const out = call.output;
    if (
      typeof out === 'object' &&
      out !== null &&
      'paymentUrl' in out &&
      typeof (out as { paymentUrl: unknown }).paymentUrl === 'string'
    ) {
      return { paymentUrl: (out as { paymentUrl: string }).paymentUrl };
    }
  }
  return null;
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
