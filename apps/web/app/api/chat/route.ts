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
import { runAgent, runAgentNoTools } from '@oplati/agent';

import { childLogger } from '@/lib/logger';
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
export const maxDuration = 30;

const log = childLogger('web-chat');
const dbLog = childLogger('db');

const MAX_MESSAGE_LEN = 4000;

const bodySchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LEN),
});

const AI_DOWN_TEXT =
  'Сейчас не получается ответить — что-то на нашей стороне. Попробуй ещё раз через минуту или напиши «оператор», и я подключу человека.';

type WebChatContext = { userId: string; conversationId: string };

/** Upsert user/conversation для веб-сессии. `null` при недоступной БД (degrade). */
async function resolveContext(webSessionId: string): Promise<WebChatContext | null> {
  try {
    const db = getDb();
    const user = await getOrCreateUserByWebSessionId(db, { webSessionId, language: 'ru' }, dbLog);
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

  if (!process.env.ANTHROPIC_API_KEY) {
    log.warn({ event: 'web-chat.disabled', reason: 'no_anthropic_key' });
    return NextResponse.json({ ok: false, error: 'ai_unavailable', text: AI_DOWN_TEXT }, { status: 200 });
  }

  const webSessionId = await getOrCreateWebSessionId();
  const ctx = await resolveContext(webSessionId);

  if (ctx) await safeAppend(ctx, 'user', text, { channel: 'web' });

  const startedAt = Date.now();
  let result: { text: string; toolCalls: unknown[] };
  try {
    if (ctx) {
      let history: MessageHistoryItem[] = [];
      try {
        history = await loadRecentMessages(getDb(), ctx.conversationId, 20, dbLog);
      } catch (err) {
        log.warn({ event: 'web-chat.history.load_failed', conversationId: ctx.conversationId, err });
      }

      const agentHistory = toAgentHistory(history, text);
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
      result = { text: r.text, toolCalls: r.toolCalls };
    } else {
      const r = await runAgentNoTools([{ role: 'user', content: text }]);
      result = { text: r.text, toolCalls: [] };
    }
  } catch (err) {
    log.error({ event: 'web-chat.agent.failed', err });
    Sentry.captureException(err, { tags: { source: 'web-chat' } });
    return NextResponse.json({ ok: false, error: 'ai_unavailable', text: AI_DOWN_TEXT }, { status: 200 });
  }

  const replyText = result.text.trim();
  log.info({
    event: 'web-chat.reply',
    durationMs: Date.now() - startedAt,
    replyLength: replyText.length,
    persisted: ctx !== null,
  });

  if (ctx && replyText) await safeAppend(ctx, 'assistant', replyText, { channel: 'web' });

  return NextResponse.json({ ok: true, text: replyText, toolCalls: result.toolCalls }, { status: 200 });
}
