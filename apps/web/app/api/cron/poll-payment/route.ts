import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { serverEnv } from '@/lib/env.server';
import { pollPayments } from '@/lib/jobs/poll-payment';
import { childLogger } from '@/lib/logger';

/**
 * GET /api/cron/poll-payment — cron-endpoint Vercel.
 * Защита: header `Authorization: Bearer <CRON_TOKEN>` (Vercel Cron шлёт его сам,
 * если задано `CRON_TOKEN` в env), либо `X-Cron-Token` для ручных вызовов.
 *
 * Расписание задаётся в `vercel.ts` (`crons: [{ path: '/api/cron/poll-payment',
 * schedule: '*\/5 * * * *' }]`).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 300;

const log = childLogger('cron-endpoint');

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorizeCron(req)) {
    log.warn({ event: 'cron.poll_payment.unauthorized' });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await pollPayments();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error({ event: 'cron.poll_payment.unexpected_error', err });
    Sentry.captureException(err, { tags: { source: 'cron.poll-payment' } });
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}

export function authorizeCron(req: Request): boolean {
  const token = process.env.CRON_SECRET ?? process.env.CRON_TOKEN;
  if (!token) {
    // На preview/dev без токена — разрешаем (план: smoke-тест локально).
    return process.env.VERCEL_ENV !== 'production';
  }
  const auth = req.headers.get('authorization');
  const xToken = req.headers.get('x-cron-token');
  return auth === `Bearer ${token}` || xToken === token;
}

// keep serverEnv reference to satisfy lazy loading
void serverEnv;
