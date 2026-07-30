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

/**
 * Момент старта процесса. Считаем один раз при загрузке модуля: `process.uptime()`
 * на каждом запросе дал бы то же значение с точностью до дрейфа, а так ответ
 * стабилен и его можно сравнивать между запросами.
 */
const STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

export function GET(): NextResponse {
  // Окружение (VERCEL_ENV) держим только в логах — наружу не отдаём, чтобы
  // публичный healthcheck не раскрывал метаданные деплоя.
  const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development';
  log.debug({ event: 'api.health.hit', env });
  // `startedAt` — для проверки после деплоя: workflow ждёт, пока прод не ответит
  // временем старта ПОЗЖЕ момента триггера, то есть пока контейнер реально не
  // пересоздан. Раньше пайплайн заканчивался на «триггер принят», и провал
  // сборки оставался незамеченным (та же слепота дважды била по проду —
  // потерянные вебхуки Vercel и Dokploy App, docs/incidents.md).
  //
  // Отдаём именно время старта, а НЕ git SHA: репозиторий публичный, и версия
  // сборки дала бы точное соответствие «прод ↔ строки кода», включая то, какие
  // фиксы ещё не выкачены. Время старта такой связи не даёт.
  return NextResponse.json(
    { status: 'ok', timestamp: new Date().toISOString(), startedAt: STARTED_AT },
    { status: 200 },
  );
}
