import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { getDb, getOrCreateUserByWebSessionId, getOrderById } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { getOrCreateWebSessionId } from '@/lib/chat/session';

/**
 * GET /api/orders/status?id=<orderId> — статус заказа для веб-чата (поллинг
 * после создания счёта, чтобы показать штамп «ОПЛАЧЕНО» + конфетти при оплате).
 *
 * Read-only. Ownership: резолвим userId из cookie-сессии и сверяем с владельцем
 * заказа — чужой orderId получает 404.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';

const log = childLogger('web-chat-status');
const dbLog = childLogger('db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Статусы, означающие «деньги получены» (для штампа ОПЛАЧЕНО).
const PAID_STATUSES = new Set([
  'paid',
  'in_fulfillment',
  'completed',
  'refund_requested',
  'refunded',
]);

export async function GET(req: Request): Promise<NextResponse> {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: 'invalid_id' }, { status: 400 });
  }

  try {
    const webSessionId = await getOrCreateWebSessionId();
    const db = getDb();
    const user = await getOrCreateUserByWebSessionId(db, { webSessionId, language: 'ru' }, dbLog);
    const order = await getOrderById(db, id);
    if (!order || order.userId !== user.id) {
      return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json(
      { ok: true, status: order.status, paid: PAID_STATUSES.has(order.status) },
      { status: 200 },
    );
  } catch (err) {
    log.error({ event: 'web-chat.status.failed', err });
    Sentry.captureException(err, { tags: { source: 'web-chat.status' } });
    // 503, а не 200: это браузерный endpoint (клиент читает только тело),
    // честный статус нужен мониторингу. Конвенция «всегда 200» — только
    // для webhook'ов с ретраями (Telegram/L&P).
    return NextResponse.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }
}
