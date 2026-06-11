import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { getDb, getWebSessionProfile } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { readWebSessionId } from '@/lib/chat/session';

/**
 * GET /api/profile — профиль текущей веб-сессии для правой панели:
 * имя (display_name из Telegram после привязки), статус привязки и реальная
 * статистика покупок из orders (оплаченные: paid/in_fulfillment/completed).
 * Read-only: cookie и пользователя не создаёт; новому посетителю — нули.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 10;

const log = childLogger('profile');

const EMPTY = {
  displayName: null,
  telegramLinked: false,
  ordersCount: 0,
  totalSpentKopecks: 0,
};

export async function GET(): Promise<NextResponse> {
  try {
    const webSessionId = await readWebSessionId();
    if (!webSessionId) {
      return NextResponse.json({ ok: true, profile: EMPTY }, { status: 200 });
    }
    const profile = await getWebSessionProfile(getDb(), webSessionId);
    return NextResponse.json({ ok: true, profile }, { status: 200 });
  } catch (err) {
    log.error({ event: 'profile.failed', err });
    Sentry.captureException(err, { tags: { source: 'profile' } });
    return NextResponse.json({ ok: false, profile: EMPTY }, { status: 200 });
  }
}
