import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { createConversation, findUserIdByWebSessionId, getDb } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { readWebSessionId } from '@/lib/chat/session';

/**
 * POST /api/chat/clear — кнопка «Очистить диалог» в веб-чате.
 *
 * Ничего не удаляет: создаёт НОВЫЙ conversation (channel='web') — он
 * становится активным (последний по created_at), и история/контекст агента
 * начинаются с чистого листа. Старый разговор и сообщения остаются в БД
 * (append-only дух, см. docs/database.md).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 10;

const log = childLogger('web-chat-clear');
const dbLog = childLogger('db');

export async function POST(): Promise<NextResponse> {
  const webSessionId = await readWebSessionId();
  if (!webSessionId) {
    // Нет cookie → нечего чистить, диалог и так пуст.
    return NextResponse.json({ ok: true });
  }

  try {
    const db = getDb();
    const userId = await findUserIdByWebSessionId(db, webSessionId);
    if (!userId) return NextResponse.json({ ok: true });

    const conversation = await createConversation(db, { userId, channel: 'web' }, dbLog);
    log.info({ event: 'web-chat.cleared', conversationId: conversation.id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.error({ event: 'web-chat.clear.failed', err });
    Sentry.captureException(err, { tags: { source: 'web-chat.clear' } });
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
