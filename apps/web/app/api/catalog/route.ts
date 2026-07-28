import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { loadCatalog } from '@/lib/catalog/load';
import { filterCatalogForDisplay } from '@/lib/catalog/build';
import { childLogger } from '@/lib/logger';
import { currentBuyerFeePercent } from '@/lib/payments/gateway';

/**
 * GET /api/catalog — витрина кнопочного флоу веб-чата: активные сервисы
 * с тарифами и рублёвой оценкой «к оплате» (курс + комиссия). Ноль AI-токенов.
 *
 * Сборка и кэш (5 мин) — в `lib/catalog/load.ts` (общий с Telegram-ботом).
 *
 * `buyerFeePercent` — надбавка ТЕКУЩЕГО шлюза на плательщика (0 у L&P). Отдаём
 * вместе с ценами, потому что предупредить о ней надо там же, где показана
 * сумма; в кэш витрины не кладём — она зависит от env, а не от каталога.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('api.catalog');

export async function GET(): Promise<NextResponse> {
  try {
    const services = filterCatalogForDisplay(await loadCatalog());
    return NextResponse.json(
      { ok: true, services, buyerFeePercent: currentBuyerFeePercent() },
      { status: 200 },
    );
  } catch (err) {
    log.error({ event: 'api.catalog.failed', err });
    Sentry.captureException(err, { tags: { source: 'api.catalog' } });
    return NextResponse.json({ ok: false, error: 'catalog_unavailable' }, { status: 503 });
  }
}
