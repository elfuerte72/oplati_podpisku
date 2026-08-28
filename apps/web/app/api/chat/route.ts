import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  appendMessage,
  getDb,
  getOrCreateActiveConversation,
  getOrCreateUserByWebSessionId,
  loadRecentMessages,
  type MessageHistoryItem,
} from '@oplati/db';
import {
  AgentLoopError,
  classifyMessage,
  runAgent,
  runAgentNoTools,
  type AgentMessage,
  type RouteDecision,
  type RouteKind,
} from '@oplati/agent';

import {
  BUDGET_EXCEEDED_TEXT,
  isAiBudgetExceeded,
  mergeUsage,
  recordAgentUsage,
  type AgentUsageLike,
} from '@/lib/ai/budget';
import { serverEnv } from '@/lib/env.server';
import { isSupportAiEnabled } from '@/lib/telegram/support-session';
import { childLogger } from '@/lib/logger';
import { checkRateLimit, getClientIp } from '@/lib/ratelimit';
import { rememberClientIp } from '@/lib/contacts/track-ip';
import { createToolHandlers } from '@/lib/tool-handlers';
import { getOrCreateWebSessionId } from '@/lib/chat/session';
import { toAgentHistory } from '@/lib/chat/history';

/**
 * POST /api/chat — веб-чат (тот же AI-агент, что и Telegram).
 *
 * Контракт (расширяет docs/web-chat.md): клиент шлёт `{ message }` (только
 * новый текст), история — источник правды БД, не localStorage. Сервер:
 * cookie-сессия → upsert user/conversation (channel='web') → append user →
 * loadRecentMessages → runAgent (tools) → append assistant → JSON-ответ.
 *
 * ADR (отклонение от web-chat.md §Стриминг): web-chat.md предписывал AI SDK
 * `streamText`, но реальный агент `@oplati/agent` устроен на @anthropic-ai/sdk
 * и НЕ стримит (возвращает финальный текст + toolCalls). PRD-инвариант «оба
 * канала используют ОДНОГО агента» приоритетнее детали стриминга — поэтому
 * переиспользуем `runAgent`. Token-стриминг отложен до рефакторинга агента.
 *
 * Graceful degradation: нет ANTHROPIC_API_KEY / Anthropic упал / БД недоступна —
 * отвечаем понятным текстом, не роняем клиент.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
// 90с, а не 30 (M-6 аудита): tool-loop может внутри хода сделать self-call
// payments/create (у того maxDuration=60, свой таймаут 45с) — 30с обрезали бы
// chat-функцию ПОСЛЕ создания инвойса, но до записи usage и ответа клиенту.
export const maxDuration = 90;

const log = childLogger('web-chat');
const dbLog = childLogger('db');

const MAX_MESSAGE_LEN = 4000;

const bodySchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LEN),
});

const AI_DOWN_TEXT =
  'Сейчас не получается ответить — что-то на нашей стороне. Попробуй ещё раз через минуту или напиши «оператор», и я подключу человека.';

const RATE_LIMITED_TEXT =
  'Слишком много сообщений подряд. Подожди минутку и напиши снова — я никуда не денусь.';

/**
 * Ответ при выключенном AI-диалоге (WEB_AI_ENABLED, дефолт выключено):
 * покупка на сайте кнопочная, поэтому вместо агента — мгновенная заготовка,
 * уводящая в каталог. UI не меняется, сообщение рисуется обычным пузырём.
 */
const CHAT_DISABLED_BASE =
  'Я принимаю заказы через каталог — нажмите «Выбрать сервис», и оформим всё в пару кликов. ' +
  'Нужна помощь — поддержка живёт в нашем Telegram-боте: команда /start, кнопка «Поддержка». ';
// Кто ответит в боте — зависит от флага помощника: обещать помощника, которого
// выключили, значит обещать то, чего клиент не получит.
function chatDisabledText(): string {
  return (
    CHAT_DISABLED_BASE +
    (isSupportAiEnabled()
      ? 'Там на вопросы отвечает помощник поддержки, а при необходимости подключается оператор.'
      : 'Там вам ответит оператор.')
  );
}

type WebChatContext = { userId: string; conversationId: string };

/** Upsert user/conversation для веб-сессии. `null` при недоступной БД (degrade). */
async function resolveContext(webSessionId: string): Promise<WebChatContext | null> {
  try {
    const db = getDb();
    // Захват реферера через веб удалён (2026-07-02): рефералы фиксируются
    // ТОЛЬКО при /start бота по deep-link `ref_<code>` — referredBy тут всегда null.
    const user = await getOrCreateUserByWebSessionId(
      db,
      { webSessionId, language: 'ru', referredBy: null },
      dbLog,
    );
    const conversation = await getOrCreateActiveConversation(
      db,
      { userId: user.id, channel: 'web' },
      dbLog,
    );
    return { userId: user.id, conversationId: conversation.id };
  } catch (err) {
    log.error({ event: 'web-chat.persist.failed', err });
    Sentry.captureException(err, { tags: { source: 'web-chat.persist' } });
    return null;
  }
}

async function safeAppend(
  ctx: WebChatContext,
  role: 'user' | 'assistant',
  content: string,
  meta: Record<string, unknown> | null,
): Promise<void> {
  try {
    await appendMessage(getDb(), { conversationId: ctx.conversationId, role, content, meta }, dbLog);
  } catch (err) {
    log.error({ event: 'web-chat.persist.message_failed', role, err });
    Sentry.captureException(err, { tags: { source: 'web-chat.persist', step: 'appendMessage' } });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_json', text: 'Не удалось прочитать сообщение.' },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: 'invalid_body',
        text: 'Сообщение пустое или слишком длинное (максимум 4000 символов).',
      },
      { status: 400 },
    );
  }
  const text = parsed.data.message;

  // AI-диалог на сайте — за флагом WEB_AI_ENABLED (решение владельца 2026-07-19,
  // по образцу BOT_AI_ENABLED). Выключен → мгновенная заготовка: ни Anthropic,
  // ни сессии/записей в БД. Rate-limit осознанно НЕ зовём — ответ статический
  // и дешевле самого лимитера; DoS-поверхности здесь нет.
  if (!serverEnv.WEB_AI_ENABLED) {
    log.info({ event: 'web-chat.disabled_by_flag', messageLength: text.length });
    return NextResponse.json(
      { ok: true, text: chatDisabledText(), toolCalls: [] },
      { status: 200 },
    );
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    log.warn({ event: 'web-chat.disabled', reason: 'no_anthropic_key' });
    return NextResponse.json({ ok: false, error: 'ai_unavailable', text: AI_DOWN_TEXT }, { status: 200 });
  }

  // Per-IP rate-limit ДО роутера/агента: режет DoS-на-бюджет от одного источника.
  // Работает независимо от Supabase (Upstash), fail-open если не сконфигурирован.
  const rl = await checkRateLimit('web-chat', getClientIp(req));
  if (!rl.allowed) {
    log.warn({ event: 'web-chat.rate_limited' });
    return NextResponse.json(
      { ok: false, error: 'rate_limited', text: RATE_LIMITED_TEXT },
      { status: 429 },
    );
  }

  const webSessionId = await getOrCreateWebSessionId();
  const ctx = await resolveContext(webSessionId);

  // Антифрод-трек (тикет 01): любой живой запрос клиента освежает last_seen_ip.
  if (ctx) await rememberClientIp(req, ctx.userId);

  if (ctx) await safeAppend(ctx, 'user', text, { channel: 'web' });

  // Дневной глобальный токен-бюджет: при превышении отвечаем заготовкой,
  // не вызывая Anthropic вообще (ни роутер, ни агента).
  if (await isAiBudgetExceeded()) {
    log.warn({ event: 'web-chat.budget_exceeded' });
    if (ctx) await safeAppend(ctx, 'assistant', BUDGET_EXCEEDED_TEXT, { source: 'budget_guard' });
    return NextResponse.json(
      { ok: true, text: BUDGET_EXCEEDED_TEXT, toolCalls: [] },
      { status: 200 },
    );
  }

  const startedAt = Date.now();
  let routedAs: RouteKind = 'agent';
  let result: {
    text: string;
    toolCalls: unknown[];
    usage?: AgentUsageLike | null;
    /** Модель не довела ход до конца — текст служебный, действий к нему не клеим. */
    incomplete?: boolean;
  };
  // Объявлено ВНЕ try: при сбое агента токены роутера уже потрачены, и catch
  // должен их видеть, чтобы записать в дневной бюджет.
  let routerUsage: AgentUsageLike | null = null;
  try {
    let agentHistory: AgentMessage[] = [{ role: 'user', content: text }];
    if (ctx) {
      let history: MessageHistoryItem[] = [];
      try {
        history = await loadRecentMessages(getDb(), ctx.conversationId, 20, dbLog);
      } catch (err) {
        log.warn({ event: 'web-chat.history.load_failed', conversationId: ctx.conversationId, err });
      }
      agentHistory = toAgentHistory(history, text);
    }

    // Haiku-роутер: приветствие/оффтоп/инъекция → каннед-ответ без Sonnet.
    // Fail-open: упавший классификатор не блокирует агента.
    let route: RouteDecision = { route: 'agent', usage: null };
    try {
      route = await classifyMessage(agentHistory);
    } catch (err) {
      log.warn({ event: 'web-chat.router_failed', err });
      Sentry.captureException(err, { tags: { source: 'web-chat.router' } });
    }
    routerUsage = route.usage;

    if (route.route !== 'agent') {
      routedAs = route.route;
      result = { text: route.cannedText, toolCalls: [], usage: route.usage };
    } else if (ctx) {
      const toolHandlers = createToolHandlers({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
      });
      const r = await runAgent(agentHistory, {
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        channel: 'web',
        toolHandlers,
      });
      result = {
        text: r.text,
        toolCalls: r.toolCalls,
        usage: mergeUsage(route.usage, r.usage),
        incomplete: r.incomplete,
      };
    } else {
      const r = await runAgentNoTools(agentHistory);
      result = {
        text: r.text,
        toolCalls: [],
        usage: mergeUsage(route.usage, r.usage),
        incomplete: r.incomplete,
      };
    }
  } catch (err) {
    log.error({ event: 'web-chat.agent.failed', err });
    Sentry.captureException(err, { tags: { source: 'web-chat' } });
    // Токены, потраченные до сбоя, всё равно списаны провайдером — записываем
    // их в дневной бюджет (аудит 2026-08-10). Без этого самые дорогие запросы
    // (несколько итераций tool-loop, упавших на последней) стоили бюджету ноль,
    // и защита расходов слепла ровно на том, от чего защищает.
    if (err instanceof AgentLoopError) {
      await recordAgentUsage(mergeUsage(routerUsage, err.usage));
      // Что цикл успел сделать до сбоя — факты о деньгах (созданный заказ,
      // выставленный счёт). Молча выбросить их нельзя.
      const succeeded = err.toolCalls.filter((c) => !c.isError).map((c) => c.name);
      if (succeeded.length > 0) {
        log.error({ event: 'web-chat.tool_calls_abandoned', reason: err.reason, toolCalls: succeeded });
        Sentry.captureMessage('Agent loop failed after side effects', {
          level: 'error',
          tags: { source: 'web-chat' },
          extra: { reason: err.reason, toolCalls: succeeded },
        });
      }
    }
    // Заглушку пишем в историю так же, как обычный ответ (ревью 2026-08-11):
    // сообщение пользователя уже записано, и ветка без записи копит подряд
    // идущие user-строки — `toAgentHistory` схлопывает их в ОДИН ход, и агент
    // потом отвечает на слипшийся комок старых намерений.
    if (ctx) await safeAppend(ctx, 'assistant', AI_DOWN_TEXT, { channel: 'web', source: 'ai_unavailable' });
    return NextResponse.json({ ok: false, error: 'ai_unavailable', text: AI_DOWN_TEXT }, { status: 200 });
  }

  await recordAgentUsage(result.usage);

  const replyText = result.text.trim();
  log.info({
    event: 'web-chat.reply',
    durationMs: Date.now() - startedAt,
    replyLength: replyText.length,
    persisted: ctx !== null,
    // 'agent' — обычный путь; greeting/offtopic/injection — каннед без Sonnet
    routedAs,
    inputTokens: result.usage?.input_tokens,
    outputTokens: result.usage?.output_tokens,
    // Prompt caching: read > 0 — префикс tools+system пришёл из кэша (~0.1x цены)
    cacheReadTokens: result.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: result.usage?.cache_creation_input_tokens ?? 0,
    webSearchRequests: result.usage?.server_tool_use?.web_search_requests ?? 0,
  });

  if (ctx && replyText) await safeAppend(ctx, 'assistant', replyText, { channel: 'web' });

  // Карточки заказа — только к ЗАВЕРШЁННОМУ ответу: у них есть кнопка оплаты, а
  // в служебном тексте оборванного ответа суммы нет (ревью 2026-08-11).
  return NextResponse.json(
    { ok: true, text: replyText, toolCalls: result.incomplete ? [] : result.toolCalls },
    { status: 200 },
  );
}
