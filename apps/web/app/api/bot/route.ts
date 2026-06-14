import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { telegramUpdateSchema } from '@oplati/types';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/security/timing-safe';
import { handleTelegramUpdate } from '@/lib/telegram/handle-update';

/**
 * POST /api/bot — Telegram webhook (milestone «Telegram webhook + AI v1»).
 *
 * Контракт (см. `docs/api.md`, `docs/telegram-integration.md`):
 *   1. Проверяем `X-Telegram-Bot-Api-Secret-Token` ПЕРВЫМ, до парсинга body.
 *      Несовпадение — единственный кейс, где webhook отвечает не 200, а 401.
 *   2. Все остальные кейсы (невалидный JSON, не прошёл Zod, бросилась
 *      внутренняя ошибка, env не сконфигурирован) — отвечаем 200, иначе
 *      Telegram будет ретраить и забьёт очередь.
 *   3. PII в логи не уходит: тексты сообщений редактируются как `*.text` /
 *      `body.text` в `lib/logger.ts`. Здесь логируем только метаданные.
 *
 * Runtime: Node, не Edge — pino требует Node API.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 30;

const log = childLogger('telegram-bot');

const ok = (extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: true, ...extra }, { status: 200 });

export async function POST(req: Request): Promise<NextResponse> {
  const expectedSecret = serverEnv.TELEGRAM_WEBHOOK_SECRET;

  if (!expectedSecret) {
    log.warn({
      event: 'telegram.bot.disabled',
      missing: collectMissingEnv(),
    });
    return ok({ skipped: 'not_configured' });
  }

  const headerSecret = req.headers.get('x-telegram-bot-api-secret-token');
  if (!timingSafeEqualStr(headerSecret ?? '', expectedSecret)) {
    log.warn({ event: 'telegram.webhook.unauthorized' });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const missing = collectMissingEnv();
  if (missing.length > 0) {
    log.warn({ event: 'telegram.bot.disabled', missing });
    return ok({ skipped: 'not_configured' });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    log.error({ event: 'telegram.webhook.invalid_json', err });
    Sentry.captureException(err, { tags: { source: 'telegram.bot' } });
    return ok({ skipped: 'invalid_json' });
  }

  const parsed = telegramUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn({
      event: 'telegram.update.invalid',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return ok({ skipped: 'invalid_update' });
  }

  log.debug({
    event: 'telegram.webhook.received',
    updateId: parsed.data.update_id,
    hasMessage: parsed.data.message !== undefined,
  });

  try {
    await handleTelegramUpdate(parsed.data);
  } catch (err) {
    log.error({
      event: 'telegram.handler.failed',
      updateId: parsed.data.update_id,
      err,
    });
    Sentry.captureException(err, { tags: { source: 'telegram.bot' } });
  }

  return ok();
}

function collectMissingEnv(): string[] {
  const missing: string[] = [];
  if (!serverEnv.TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!serverEnv.TELEGRAM_WEBHOOK_SECRET) missing.push('TELEGRAM_WEBHOOK_SECRET');
  if (!serverEnv.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  return missing;
}
