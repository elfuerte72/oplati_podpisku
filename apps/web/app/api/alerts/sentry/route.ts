import { NextResponse } from 'next/server';

import { formatSentryAlertMessage, sentryAlertPayloadSchema } from '@/lib/alerts/sentry';
import { isOpsDeliveryConfigured, notifyStream } from '@/lib/alerts/streams';
import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { checkRateLimit, getClientIp } from '@/lib/ratelimit';
import { timingSafeEqualStr } from '@/lib/security/timing-safe';

/**
 * POST /api/alerts/sentry — relay алёртов Sentry в Telegram.
 *
 * Sentry alert rule (экшен «Send a notification via a webhook») бьёт сюда с
 * секретом в query (`?s=<SENTRY_ALERT_WEBHOOK_SECRET>`); endpoint форматирует
 * issue и шлёт в поток `errors` (`notifyStream`): при заданной ops-группе —
 * тема «Ошибки» ботом входа, без группы — прежняя личка `ALERT_TELEGRAM_CHAT_ID`
 * через alert-бота.
 *
 * Гейт — секрет в query или заголовке `X-Alert-Token` (timing-safe). Не
 * сконфигурирован (нет секрета или некуда слать) → no-op 200, чтобы Sentry не
 * пометил webhook сломанным.
 *
 * ВАЖНО (анти-петля): при ошибке доставки в Telegram НЕ зовём
 * `Sentry.captureException` — это создало бы новый issue → новый alert → снова
 * этот webhook → бесконечный цикл. Только локальный `log.error`; модулю потоков
 * это передаётся флагом `reportToSentry: false` (иначе он сообщил бы о
 * протухшей теме).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('alerts.sentry');

export async function POST(req: Request): Promise<NextResponse> {
  const secret = serverEnv.SENTRY_ALERT_WEBHOOK_SECRET;
  const hasTarget = isOpsDeliveryConfigured();

  if (!secret || !hasTarget) {
    log.warn({
      event: 'alerts.sentry.disabled',
      hasSecret: Boolean(secret),
      hasTarget,
    });
    return NextResponse.json({ ok: true, skipped: 'not_configured' }, { status: 200 });
  }

  // Секрет в query (`?s=`) — вынужденный компромисс, а не лень: экшен «webhook»
  // в Sentry не умеет кастомные заголовки, поэтому header-only сломал бы алёрты
  // целиком. Заголовок `X-Alert-Token` принимаем как альтернативу для ручных
  // вызовов и на случай, если Sentry когда-нибудь научится.
  //
  // Цена компромисса: значение видно в access-логах Traefik. Убрать его оттуда
  // можно только настройкой прокси; что зависит от кода — ограничить ПОДБОР,
  // поэтому неудачные попытки идут под rate-limit по IP.
  const provided =
    new URL(req.url).searchParams.get('s') ?? req.headers.get('x-alert-token') ?? '';
  if (!provided || !timingSafeEqualStr(provided, secret)) {
    // Лимит проверяется ПОСЛЕ неудачи и только для неудач: успешные алёрты не
    // должны отбрасываться никогда, особенно в шторм.
    const rl = await checkRateLimit('alert-webhook-auth', getClientIp(req));
    log.warn({ event: 'alerts.sentry.unauthorized', throttled: !rl.allowed });
    if (!rl.allowed) {
      return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 });
    }
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

  const { text, degraded } = formatSentryAlertMessage(parsed.data);
  if (degraded) {
    // Формат payload'а разошёлся с парсером: алёрт уйдёт, но без названия
    // проблемы. Ключи верхнего уровня — единственная зацепка для разбора
    // (значения не логируем: в событии Sentry бывают данные клиента).
    log.warn({ event: 'alerts.sentry.degraded', keys: Object.keys(parsed.data).sort() });
  }

  // `notifyStream` не бросает и Sentry не зовёт (анти-петля) — ошибку доставки
  // он логирует сам; здесь остаётся только честный ответ Sentry.
  const delivered = await notifyStream('errors', text, { reportToSentry: false });
  if (!delivered) {
    log.error({ event: 'alerts.sentry.telegram_failed' });
    return NextResponse.json({ ok: false, skipped: 'telegram_failed' }, { status: 200 });
  }
  log.info({ event: 'alerts.sentry.forwarded' });

  return NextResponse.json({ ok: true }, { status: 200 });
}
