import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { loadCatalog } from '@/lib/catalog/load';
import { childLogger } from '@/lib/logger';

/**
 * GET /api/catalog — витрина кнопочного флоу веб-чата: активные сервисы
 * с тарифами и рублёвой оценкой «к оплате» (курс + комиссия). Ноль AI-токенов.
 *
 * Сборка и кэш (5 мин) — в `lib/catalog/load.ts` (общий с Telegram-ботом).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('api.catalog');

export async function GET(): Promise<NextResponse> {
  try {
    const services = await loadCatalog();
    return NextResponse.json({ ok: true, services }, { status: 200 });
  } catch (err) {
    log.error({ event: 'api.catalog.failed', err });
    Sentry.captureException(err, { tags: { source: 'api.catalog' } });
    return NextResponse.json({ ok: false, error: 'catalog_unavailable' }, { status: 503 });
  }
}
