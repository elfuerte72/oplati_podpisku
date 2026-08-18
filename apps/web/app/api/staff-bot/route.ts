import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { telegramUpdateSchema } from '@oplati/types';

import { claimOnce, extendClaim } from '@/lib/dedup';
import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/security/timing-safe';
import { botIdFromToken } from '@/lib/telegram/bot';
import { handleStaffBotUpdate } from '@/lib/telegram/staff-bot';

/**
 * POST /api/staff-bot — точка приёма бота ПЕРСОНАЛА
 * (`@oplatishkaasupport_bot`, id 7992756364).
 *
 * Отдельная от клиентской (`/api/bot`) и со СВОИМ секретом: общий означал бы,
 * что компрометация одного открывает точку приёма другого.
 *
 * ⚠️ Путь НЕ под `/api/panel` намеренно: панель на публичных доменах отдаёт
 * 404, а до вебхука должны дотягиваться серверы Telegram.
 *
 * Контракт как у клиентского бота: единственный non-200 — неверный
 * secret-token (инвариант 6). Дедуп по `update_id` — свой ключ с id бота,
 * иначе два бота гасили бы апдейты друг друга в общем Redis.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('telegram.staff-bot');

const IN_FLIGHT_TTL_SECONDS = 30;
const DONE_TTL_SECONDS = 600;

const ok = (extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: true, ...extra }, { status: 200 });

export async function POST(req: Request): Promise<NextResponse> {
  const expectedSecret = serverEnv.TELEGRAM_LOGIN_BOT_WEBHOOK_SECRET;
  if (!expectedSecret) {
    log.warn({ event: 'telegram.staff_bot.disabled', missing: 'TELEGRAM_LOGIN_BOT_WEBHOOK_SECRET' });
    return ok({ skipped: 'not_configured' });
  }

  const headerSecret = req.headers.get('x-telegram-bot-api-secret-token');
  if (!timingSafeEqualStr(headerSecret ?? '', expectedSecret)) {
    log.warn({ event: 'telegram.staff_bot.unauthorized' });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  if (!serverEnv.TELEGRAM_LOGIN_BOT_TOKEN) {
    log.warn({ event: 'telegram.staff_bot.disabled', missing: 'TELEGRAM_LOGIN_BOT_TOKEN' });
    return ok({ skipped: 'not_configured' });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    log.error({ event: 'telegram.staff_bot.invalid_json', err });
    Sentry.captureException(err, { tags: { source: 'telegram.staff-bot' } });
    return ok({ skipped: 'invalid_json' });
  }

  const parsed = telegramUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn({ event: 'telegram.staff_bot.invalid_update' });
    return ok({ skipped: 'invalid_update' });
  }

  const dedupKey = `tg:upd:${botIdFromToken(serverEnv.TELEGRAM_LOGIN_BOT_TOKEN)}:${parsed.data.update_id}`;
  if (!(await claimOnce(dedupKey, IN_FLIGHT_TTL_SECONDS))) {
    log.info({ event: 'telegram.staff_bot.duplicate', updateId: parsed.data.update_id });
    return ok({ skipped: 'duplicate' });
  }

  try {
    await handleStaffBotUpdate(parsed.data);
  } catch (err) {
    // Обработчик не бросает по контракту, но 200 отвечаем в любом случае.
    log.error({ event: 'telegram.staff_bot.handler_failed', err });
    Sentry.captureException(err, { tags: { source: 'telegram.staff-bot' } });
  }

  await extendClaim(dedupKey, DONE_TTL_SECONDS);
  return ok();
}
