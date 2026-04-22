import { NextResponse } from 'next/server';

import { childLogger } from '@/lib/logger';

/**
 * Healthcheck endpoint.
 *
 * Используется:
 *   - Vercel / monitoring для uptime-проверок (Sprint 3 SLO — availability 99.5%)
 *   - ручной smoke после деплоя
 *
 * Не читаем БД / внешние сервисы — это liveness, не readiness.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = childLogger('api.health');

export function GET(): NextResponse {
  const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development';
  const body = {
    status: 'ok',
    env,
    timestamp: new Date().toISOString(),
  };
  log.debug({ event: 'api.health.hit', env });
  return NextResponse.json(body, { status: 200 });
}
