import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { runSupportHousekeeping } from '@/lib/jobs/support-housekeeping';
import { childLogger } from '@/lib/logger';

import { authorizeCron } from '../poll-payment/route';

/**
 * Хозяйство поддержки (тикет 06): автозакрытие разговоров у оператора после
 * суток тишины клиента + алёрт «обращение без ответа больше двух часов».
 * Расписание — раз в 15 минут, `infra/crontab.example`.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 300;

const log = childLogger('cron-endpoint');

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorizeCron(req)) {
    log.warn({ event: 'cron.support_housekeeping.unauthorized' });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const result = await runSupportHousekeeping();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error({ event: 'cron.support_housekeeping.unexpected_error', err });
    Sentry.captureException(err, { tags: { source: 'cron.support-housekeeping' } });
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
