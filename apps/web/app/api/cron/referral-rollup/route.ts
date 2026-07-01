import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { rollupReferralMonth } from '@/lib/jobs/referral-rollup';
import { childLogger } from '@/lib/logger';

import { authorizeCron } from '../poll-payment/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 300;

const log = childLogger('cron-endpoint');

/**
 * Cron `referral-rollup` (1-е число месяца) — месячная прогрессия партнёров
 * (Этап C): храповик кругов, бонусы достижения/спринта/серии, спринт-буст,
 * командный множитель + уведомления. Авторизация — общий `authorizeCron`
 * (fail-closed вне dev). Логика — lib/jobs/referral-rollup.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!authorizeCron(req)) {
    log.warn({ event: 'cron.referral_rollup.unauthorized' });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const result = await rollupReferralMonth();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error({ event: 'cron.referral_rollup.unexpected_error', err });
    Sentry.captureException(err, { tags: { source: 'cron.referral-rollup' } });
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
