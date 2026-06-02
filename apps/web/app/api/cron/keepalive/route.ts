import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { keepAlive } from '@/lib/jobs/keepalive';
import { childLogger } from '@/lib/logger';

import { authorizeCron } from '../poll-payment/route';

/**
 * GET /api/cron/keepalive — Vercel Cron. Пингует БД, чтобы Supabase free-tier
 * не уходил в auto-pause + health-heartbeat (алерт при недоступности БД).
 *
 * Расписание — в `apps/web/vercel.json`. ВАЖНО: Vercel Cron запускается ТОЛЬКО
 * на production-деплое и (как и остальные cron'ы проекта) требует `CRON_SECRET`
 * в env — иначе `authorizeCron` вернёт 401 на проде.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 30;

const log = childLogger('cron-endpoint');

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorizeCron(req)) {
    log.warn({ event: 'cron.keepalive.unauthorized' });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await keepAlive();
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (err) {
    log.error({ event: 'cron.keepalive.unexpected_error', err });
    Sentry.captureException(err, { tags: { source: 'cron.keepalive' } });
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
