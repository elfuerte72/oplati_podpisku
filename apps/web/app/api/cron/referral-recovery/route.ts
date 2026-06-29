import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { recoverReferralAccruals } from '@/lib/jobs/referral-accrual-recovery';
import { childLogger } from '@/lib/logger';

import { authorizeCron } from '../poll-payment/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 300;

const log = childLogger('cron-endpoint');

/**
 * Cron `referral-recovery` — бэкстоп реферальных начислений (Этап B). Раз в час
 * добирает заказы, где inline-начисление в L&P-webhook не прошло. Авторизация —
 * общий `authorizeCron` (fail-closed вне dev). См. lib/jobs/referral-accrual-recovery.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!authorizeCron(req)) {
    log.warn({ event: 'cron.referral_recovery.unauthorized' });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const result = await recoverReferralAccruals();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error({ event: 'cron.referral_recovery.unexpected_error', err });
    Sentry.captureException(err, { tags: { source: 'cron.referral-recovery' } });
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
