import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { expirePayments } from '@/lib/jobs/expire-payments';
import { childLogger } from '@/lib/logger';

import { authorizeCron } from '../poll-payment/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 300;

const log = childLogger('cron-endpoint');

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorizeCron(req)) {
    log.warn({ event: 'cron.expire_payments.unauthorized' });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const result = await expirePayments();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error({ event: 'cron.expire_payments.unexpected_error', err });
    Sentry.captureException(err, { tags: { source: 'cron.expire-payments' } });
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
