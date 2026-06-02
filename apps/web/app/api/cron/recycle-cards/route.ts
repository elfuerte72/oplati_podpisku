import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { recycleCards } from '@/lib/jobs/recycle-cards';
import { childLogger } from '@/lib/logger';

import { authorizeCron } from '../poll-payment/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 300;

const log = childLogger('cron-endpoint');

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorizeCron(req)) {
    log.warn({ event: 'cron.recycle_cards.unauthorized' });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const result = await recycleCards();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error({ event: 'cron.recycle_cards.unexpected_error', err });
    Sentry.captureException(err, { tags: { source: 'cron.recycle-cards' } });
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
