import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { findUserIdByWebSessionId, getDb, getOrderById } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { checkRateLimit, getClientIp } from '@/lib/ratelimit';
import { readWebSessionId } from '@/lib/chat/session';

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

  // Rate-limit по IP ДО резолва сессии и обращения к БД: без cookie каждый запрос
  // иначе получал бы обработку заново — раньше это плодило строки users (cost-DoS).
  const rl = await checkRateLimit('web-order-status', getClientIp(req));
  if (!rl.allowed) {
    return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 });
  }

  // Read-only endpoint: НЕ создаём сессию/пользователя. Нет cookie или нет строки
  // users → свежий посетитель не владеет никаким заказом → 404.
  const webSessionId = await readWebSessionId();
  if (!webSessionId) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  try {
    const db = getDb();
    const userId = await findUserIdByWebSessionId(db, webSessionId);
    if (!userId) {
      return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    const order = await getOrderById(db, id);
    if (!order || order.userId !== userId) {
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
