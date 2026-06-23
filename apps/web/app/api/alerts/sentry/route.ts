import { NextResponse } from 'next/server';

import { formatSentryAlertMessage, sentryAlertPayloadSchema } from '@/lib/alerts/sentry';
import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/security/timing-safe';
import { getBot } from '@/lib/telegram/bot';

/**
 * POST /api/alerts/sentry — relay алёртов Sentry в Telegram.
 *
 * Sentry alert rule (экшен «Send a notification via a webhook») бьёт сюда с
 * секретом в query (`?s=<SENTRY_ALERT_WEBHOOK_SECRET>`); endpoint форматирует
 * issue и шлёт владельцу в Telegram (`ALERT_TELEGRAM_CHAT_ID`) через бота.
 *
 * Гейт — секрет в query или заголовке `X-Alert-Token` (timing-safe). Не
 * сконфигурирован (нет секрета/chat id) → no-op 200, чтобы Sentry не пометил
 * webhook сломанным.
 *
 * ВАЖНО (анти-петля): при ошибке доставки в Telegram НЕ зовём
 * `Sentry.captureException` — это создало бы новый issue → новый alert → снова
 * этот webhook → бесконечный цикл. Только локальный `log.error`.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('alerts.sentry');

export async function POST(req: Request): Promise<NextResponse> {
  const secret = serverEnv.SENTRY_ALERT_WEBHOOK_SECRET;
  const chatId = serverEnv.ALERT_TELEGRAM_CHAT_ID;

  if (!secret || !chatId) {
    log.warn({
      event: 'alerts.sentry.disabled',
      hasSecret: Boolean(secret),
      hasChatId: Boolean(chatId),
    });
    return NextResponse.json({ ok: true, skipped: 'not_configured' }, { status: 200 });
  }

  const provided =
    new URL(req.url).searchParams.get('s') ?? req.headers.get('x-alert-token') ?? '';
  if (!provided || !timingSafeEqualStr(provided, secret)) {
    log.warn({ event: 'alerts.sentry.unauthorized' });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    log.warn({ event: 'alerts.sentry.invalid_json', err });
    return NextResponse.json({ ok: true, skipped: 'invalid_json' }, { status: 200 });
  }

  const parsed = sentryAlertPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn({ event: 'alerts.sentry.invalid_payload' });
    return NextResponse.json({ ok: true, skipped: 'invalid_payload' }, { status: 200 });
  }

  const text = formatSentryAlertMessage(parsed.data);

  try {
    await getBot().api.sendMessage(chatId, text);
    log.info({ event: 'alerts.sentry.forwarded' });
  } catch (err) {
    // НЕ captureException — иначе alert→webhook→fail→alert петля. Только лог.
    log.error({ event: 'alerts.sentry.telegram_failed', err });
    return NextResponse.json({ ok: false, skipped: 'telegram_failed' }, { status: 200 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
