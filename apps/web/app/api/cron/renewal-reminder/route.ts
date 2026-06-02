import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { sendRenewalReminders } from '@/lib/jobs/subscription-renewal-reminder';
import { childLogger } from '@/lib/logger';

import { authorizeCron } from '../poll-payment/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 300;

const log = childLogger('cron-endpoint');

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorizeCron(req)) {
    log.warn({ event: 'cron.renewal_reminder.unauthorized' });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const result = await sendRenewalReminders();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error({ event: 'cron.renewal_reminder.unexpected_error', err });
    Sentry.captureException(err, { tags: { source: 'cron.renewal-reminder' } });
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
