import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { getDb, isWebSessionLinkedToTelegram } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { readWebSessionId } from '@/lib/chat/session';

/**
 * GET /api/auth/telegram/link/status — привязана ли текущая веб-сессия
 * к Telegram. Поллится клиентом, пока пользователь жмёт Start в боте.
 * Read-only: cookie не создаёт, пользователя в БД не создаёт.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 10;

const log = childLogger('auth-telegram-link-status');

export async function GET(): Promise<NextResponse> {
  try {
    const webSessionId = await readWebSessionId();
    if (!webSessionId) {
      return NextResponse.json({ ok: true, linked: false }, { status: 200 });
    }
    const linked = await isWebSessionLinkedToTelegram(getDb(), webSessionId);
    return NextResponse.json({ ok: true, linked }, { status: 200 });
  } catch (err) {
    log.error({ event: 'auth.telegram.link_status.failed', err });
    Sentry.captureException(err, { tags: { source: 'auth.telegram.link_status' } });
    return NextResponse.json({ ok: false, linked: false }, { status: 200 });
  }
}
