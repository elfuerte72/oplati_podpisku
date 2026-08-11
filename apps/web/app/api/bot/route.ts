import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { telegramUpdateSchema } from '@oplati/types';

import { claimOnce, extendClaim } from '@/lib/dedup';
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
 *   4. Дедуп по `update_id` (аудит 2026-08-10): Telegram переДОСТАВЛЯЕТ апдейт,
 *      если не получил 200 вовремя, а обработчик синхронный и живёт до 90 с.
 *
 * Runtime: Node, не Edge — pino требует Node API.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
// 90с, а не 30 (спутник M-6 аудита): link-handoff и tool-loop агента зовут
// self-call payments/create с таймаутом 45с — 30с убивали бы функцию до его
// завершения (инвойс создан, клиент без ссылки).
export const maxDuration = 90;

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

  // Дедуп ДО обработчика, а не после: смысл в том, чтобы побочные эффекты
  // (сообщение клиенту, счёт по кнопке confirm, вызов панели VPN, платный ход
  // агента) не повторились. Ключ включает id бота — иначе прод и dev,
  // подключённые к одному Redis, гасили бы апдейты друг друга. Fail-open внутри
  // claimOnce: потерять апдейт хуже, чем обработать дважды.
  const dedupKey = `tg:upd:${botIdFromToken(serverEnv.TELEGRAM_BOT_TOKEN)}:${parsed.data.update_id}`;
  const claimed = await claimOnce(dedupKey, IN_FLIGHT_TTL_SECONDS);
  if (!claimed) {
    log.info({ event: 'telegram.webhook.duplicate', updateId: parsed.data.update_id });
    return ok({ skipped: 'duplicate' });
  }

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

  // Работа доведена до конца (успешно или с перехваченной ошибкой — в обоих
  // случаях мы отвечаем 200, и ретрай Telegram не нужен): продлеваем ключ.
  // Разделение на короткий claim и продление — защита от смерти процесса
  // (ревью 2026-08-11): ключ, сразу поставленный на длинный срок, при рестарте
  // контейнера в середине обработки гасил бы ретраи Telegram до конца TTL — а
  // ретрай здесь ЕДИНСТВЕННЫЙ путь восстановления, и апдейт терялся бы молча.
  await extendClaim(dedupKey, DONE_TTL_SECONDS);

  return ok();
}

/**
 * Срок ключа, пока апдейт В РАБОТЕ. Чуть больше `maxDuration` (90 с): его
 * задача — не пустить второй обработчик, пока жив первый. Умерший процесс ключ
 * не освободит, поэтому срок здесь короткий намеренно — иначе рестарт
 * контейнера в середине обработки превращал бы ретрай Telegram в тихую потерю.
 */
const IN_FLIGHT_TTL_SECONDS = 100;

/**
 * Срок ключа ПОСЛЕ обработки. Telegram ретраит доставку минутами, не часами;
 * 10 минут покрывают окно с запасом и не превращают Redis в архив.
 */
const DONE_TTL_SECONDS = 600;

/**
 * Числовой id бота — префикс токена до двоеточия. Не секрет (виден в любой
 * ссылке `t.me`), но однозначно разделяет прод и dev в общем Redis.
 */
function botIdFromToken(token: string | undefined): string {
  const id = token?.split(':')[0];
  return id && /^\d+$/.test(id) ? id : 'unknown';
}

/**
 * Что обязано быть задано, чтобы бот вообще работал.
 *
 * ⚠️ `ANTHROPIC_API_KEY` сюда НЕ входит (аудит 2026-08-10): его отсутствие
 * молча выключало ВЕСЬ бот, включая платёжно-критичные не-AI флоу — `/start`,
 * inline-меню, кнопку оплаты, VPN. При том что AI-диалог и так за отдельным
 * флагом `BOT_AI_ENABLED` (на проде выключен), а сам AI-путь деградирует сам
 * (см. `runAgentDialog`). Гейт по ключу обязан закрывать только AI-путь.
 */
function collectMissingEnv(): string[] {
  const missing: string[] = [];
  if (!serverEnv.TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!serverEnv.TELEGRAM_WEBHOOK_SECRET) missing.push('TELEGRAM_WEBHOOK_SECRET');
  return missing;
}
