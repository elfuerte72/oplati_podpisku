import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { runDailyReport } from '@/lib/jobs/daily-report';
import { childLogger } from '@/lib/logger';
import { resolveReportDay } from '@/lib/reports/daily-report';

import { authorizeCron } from '../poll-payment/route';

/**
 * Дневной отчёт в тему «Отчёты» ops-группы. Расписание — раз в сутки в 18:00
 * по Москве (`infra/crontab.example`): без параметров отчёт за только что
 * закрывшиеся сутки «вчера 18:00 — сегодня 18:00». `?day=YYYY-MM-DD` — ручная
 * переотправка за сутки, закончившиеся в 18:00 этой даты (ещё идущие
 * помечаются неполными).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 300;

const log = childLogger('cron-endpoint');

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorizeCron(req)) {
    log.warn({ event: 'cron.daily_report.unauthorized' });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const day = resolveReportDay(new URL(req.url).searchParams.get('day'), new Date());
  if (!day.ok) {
    return NextResponse.json({ ok: false, error: day.reason }, { status: 400 });
  }

  try {
    const result = await runDailyReport(day);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error({ event: 'cron.daily_report.unexpected_error', err });
    Sentry.captureException(err, { tags: { source: 'cron.daily-report' } });
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
