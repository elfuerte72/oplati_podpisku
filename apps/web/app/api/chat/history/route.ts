import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { findActiveConversation, findUserIdByWebSessionId, getDb, loadRecentMessages } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { readWebSessionId } from '@/lib/chat/session';

/**
 * GET /api/chat/history — восстановление диалога веб-чата после перезагрузки
 * страницы (state чата живёт в памяти клиента; источник правды — БД,
 * docs/web-chat.md). Строго read-only: ничего не создаёт — новый посетитель
 * без cookie/записей получает пустой список.
 *
 * Tool-карточки (каталог/заказ/оплата) не персистятся и не восстанавливаются —
 * только текст диалога.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 10;

const log = childLogger('web-chat-history');
const dbLog = childLogger('db');

const HISTORY_LIMIT = 50;

type HistoryMessage = { id: string; role: 'user' | 'assistant' | 'operator'; content: string };

export async function GET(): Promise<NextResponse> {
  const webSessionId = await readWebSessionId();
  if (!webSessionId) {
    return NextResponse.json({ ok: true, messages: [] satisfies HistoryMessage[] });
  }

  try {
    const db = getDb();
    const userId = await findUserIdByWebSessionId(db, webSessionId);
    if (!userId) return NextResponse.json({ ok: true, messages: [] });

    const conversationId = await findActiveConversation(db, { userId, channel: 'web' });
    if (!conversationId) return NextResponse.json({ ok: true, messages: [] });

    const history = await loadRecentMessages(db, conversationId, HISTORY_LIMIT, dbLog);
    const messages: HistoryMessage[] = history
      .filter((m): m is typeof m & { role: HistoryMessage['role'] } => m.role !== 'system')
      .map((m) => ({ id: m.id, role: m.role, content: m.content }));

    return NextResponse.json({ ok: true, messages });
  } catch (err) {
    log.error({ event: 'web-chat.history.failed', err });
    Sentry.captureException(err, { tags: { source: 'web-chat.history' } });
    // Деградация: чат стартует с приветствия, без истории — не роняем страницу.
    return NextResponse.json({ ok: false, messages: [] }, { status: 200 });
  }
}
