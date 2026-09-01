import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { runFunnelJob } from '@/lib/jobs/funnel';
import { childLogger } from '@/lib/logger';

import { authorizeCron } from '../poll-payment/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 300;

const log = childLogger('cron-endpoint');

/**
 * Cron `funnel` — движок воронки обратной связи, каждые 15 минут
 * (`lib/jobs/funnel.ts`). За флагом RETENTION_FUNNEL_ENABLED: выключен →
 * прогон отвечает `ok` с нулями, ничего не выбирая.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!authorizeCron(req)) {
    log.warn({ event: 'cron.funnel.unauthorized' });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const result = await runFunnelJob();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error({ event: 'cron.funnel.unexpected_error', err });
    Sentry.captureException(err, { tags: { source: 'cron.funnel' } });
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
