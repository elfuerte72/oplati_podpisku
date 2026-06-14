import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { serverEnv } from '@/lib/env.server';
import { pollPayments } from '@/lib/jobs/poll-payment';
import { childLogger } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/security/timing-safe';

/**
 * GET /api/cron/poll-payment — cron-endpoint Vercel.
 * Защита: header `Authorization: Bearer <CRON_SECRET>` (Vercel Cron шлёт его сам,
 * когда задан `CRON_SECRET` в env), либо `X-Cron-Token` для ручных вызовов.
 *
 * Расписание — `apps/web/vercel.json` (`crons: [{ path: '/api/cron/poll-payment',
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
  // Через валидированный serverEnv (оба ключа в Zod-схеме), а не process.env.
  const token = serverEnv.CRON_SECRET ?? serverEnv.CRON_TOKEN;
  if (!token) {
    // Fail-closed везде, кроме локальной разработки (NODE_ENV=development).
    // ВАЖНО: preview-деплои публичны (Deployment Protection отключён ради
    // Telegram) и шарят prod-Supabase/кабинет L&P — пускать cron'ы без токена
    // на preview нельзя (рециклинг карт, рассылки, опрос платежей наружу).
    return serverEnv.NODE_ENV === 'development';
  }
  const auth = req.headers.get('authorization');
  const xToken = req.headers.get('x-cron-token');
  return (
    timingSafeEqualStr(auth ?? '', `Bearer ${token}`) ||
    timingSafeEqualStr(xToken ?? '', token)
  );
}
