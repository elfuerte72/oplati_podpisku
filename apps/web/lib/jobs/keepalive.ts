import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, pingDb } from '@oplati/db';

import { childLogger } from '../logger.ts';

/**
 * Cron `keepalive` — пингует Supabase (`SELECT 1`), чтобы free-tier проект не
 * уходил в auto-pause (`INACTIVE`). Первопричина инцидента 2026-06-02: пауза БД
 * молча превращала бота в амнезика (см. `.ai-factory/patches/2026-06-02-14.30.md`).
 *
 * Заодно — health-heartbeat: на недоступность БД шлём Sentry-алерт. «БД спит/упала»
 * это ОЖИДАЕМАЯ неудача → возвращаем Result `{ ok: false }` (CLAUDE.md: Result
 * pattern для ожидаемых неудач), не бросаем. Route отдаёт 500, но не дублирует
 * Sentry — алерт уже отправлен здесь.
 */

const log = childLogger('cron.keepalive');

export async function keepAlive(): Promise<{ ok: boolean; latencyMs: number }> {
  const startedAt = Date.now();
  log.info({ event: 'cron.keepalive.start' });

  try {
    await pingDb(getDb());
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    log.error({ event: 'cron.keepalive.db_unreachable', latencyMs, err });
    Sentry.captureException(err, {
      tags: { source: 'cron.keepalive', kind: 'db_unreachable' },
    });
    return { ok: false, latencyMs };
  }

  const latencyMs = Date.now() - startedAt;
  log.info({ event: 'cron.keepalive.ok', latencyMs });
  return { ok: true, latencyMs };
}
