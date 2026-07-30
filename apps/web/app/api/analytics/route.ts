import { NextResponse } from 'next/server';

import {
  ANALYTICS_EVENTS,
  analyticsIngestBatchSchema,
  isClientTrackable,
  resolveOccurredAt,
} from '@oplati/types';
import type { AnalyticsEventInsert } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { checkRateLimit, getClientIp } from '@/lib/ratelimit';
import { readWebSessionId } from '@/lib/chat/session';
import { readTelegramIdFromInitData } from '@/lib/analytics/miniapp-identity';
import { writeEvents } from '@/lib/analytics/track';

/**
 * POST /api/analytics — приём поведенческих событий с клиента (сайт и Mini App).
 *
 * Чему здесь НЕ доверяем:
 *   - имени события: серверные имена (`bot_*`, `support_requested`) отклоняются,
 *     иначе конверсию можно было бы нарисовать curl'ом;
 *   - времени: часы клиента врут и подделываются, `resolveOccurredAt` подменяет
 *     подозрительное значение моментом получения;
 *   - props: чужие ключи молча отбрасываются allowlist'ом в схеме;
 *   - личности: `web_session_id` берётся из httpOnly-cookie, а `telegram_id` —
 *     из ПОДПИСАННОЙ `initData`, а не из тела запроса. Иначе любой мог бы
 *     дописать события в чужой путь.
 *
 * Ответ всегда быстрый и всегда 200/4xx без деталей: это фоновой запрос
 * браузера, клиенту нечего с ним делать.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';

const log = childLogger('analytics-ingest');

export async function POST(req: Request): Promise<NextResponse> {
  // Rate-limit ДО чтения cookie и любых записей: неаутентифицированный
  // write-эндпоинт (инвариант 9). Свой бакет — телеметрия не должна выедать
  // лимит оформления заказов.
  const rl = await checkRateLimit('web-analytics', getClientIp(req));
  if (!rl.allowed) {
    return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const parsed = analyticsIngestBatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 400 });
  }

  const webSessionId = await readWebSessionId();
  const telegramId = readTelegramIdFromInitData(req.headers.get('x-telegram-init-data'));

  // Ни cookie, ни подписанной initData — событие некуда подшить. Молча
  // принимаем (клиенту это не интересно), но не пишем: строки без identity
  // засоряют таблицу и не попадают ни в одну воронку.
  if (!webSessionId && !telegramId) {
    return NextResponse.json({ ok: true, accepted: 0 }, { status: 200 });
  }

  const receivedAt = new Date();
  const rows: AnalyticsEventInsert[] = [];

  for (const event of parsed.data.events) {
    if (!isClientTrackable(event.name)) {
      log.warn({ event: 'analytics.server_only_rejected', name: event.name });
      continue;
    }
    // Канал берём из словаря, а не из тела: клиент не решает, чем он является.
    const spec = ANALYTICS_EVENTS[event.name];
    rows.push({
      eventKey: event.eventKey,
      name: event.name,
      channel: event.channel === 'miniapp' && spec.channel === 'web' ? 'miniapp' : spec.channel,
      origin: 'client',
      webSessionId: webSessionId ?? null,
      telegramId: telegramId ?? null,
      orderId: null,
      props: event.orderRef ? { ...event.props, order_ref: event.orderRef } : event.props,
      occurredAt: resolveOccurredAt(event.occurredAt, receivedAt),
    });
  }

  const accepted = await writeEvents(rows);
  return NextResponse.json({ ok: true, accepted }, { status: 200 });
}
