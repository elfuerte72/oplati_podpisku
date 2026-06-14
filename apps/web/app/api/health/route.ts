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
export const preferredRegion = 'fra1';
export const maxDuration = 5;

const log = childLogger('api.health');

export function GET(): NextResponse {
  // Окружение (VERCEL_ENV) держим только в логах — наружу не отдаём, чтобы
  // публичный healthcheck не раскрывал метаданные деплоя.
  const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development';
  log.debug({ event: 'api.health.hit', env });
  return NextResponse.json({ status: 'ok', timestamp: new Date().toISOString() }, { status: 200 });
}
