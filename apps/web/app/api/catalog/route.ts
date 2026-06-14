import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { getDb, listActiveServices } from '@oplati/db';

import { buildCatalogService, sortCatalog, type CatalogService } from '@/lib/catalog/build';
import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { resolveUsdtRubRate } from '@/lib/loveandpay/rates';

/**
 * GET /api/catalog — витрина кнопочного флоу веб-чата: активные сервисы
 * с тарифами и рублёвой оценкой «к оплате» (курс + комиссия). Ноль AI-токенов.
 *
 * Кэш — module-level (5 мин): бережёт вызов курса L&P и запрос к БД; дрейф
 * витринной цены ≤ TTL не страшен — финальная сумма фиксируется заново
 * в /api/orders/propose. Кэш в памяти инстанса, не общий между регионами —
 * для каталога это норм.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('api.catalog');

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { services: CatalogService[]; expiresAt: number } | null = null;

export async function GET(): Promise<NextResponse> {
  if (cache && cache.expiresAt > Date.now()) {
    return NextResponse.json({ ok: true, services: cache.services }, { status: 200 });
  }

  try {
    const db = getDb();
    const [rows, rate] = await Promise.all([listActiveServices(db), resolveUsdtRubRate()]);
    const commissionPercent = serverEnv.COMMISSION_PERCENT;

    const services: CatalogService[] = [];
    for (const r of rows) {
      const svc = buildCatalogService(r, rate, commissionPercent);
      if (svc) {
        services.push(svc);
      } else {
        // Сервис активен, но показать нечего (битая policy / нет USD-тарифов) —
        // владельцу важно это видеть, иначе сервис молча выпадет из витрины.
        log.warn({ event: 'api.catalog.service_skipped', slug: r.slug });
      }
    }

    const sorted = sortCatalog(services);
    cache = { services: sorted, expiresAt: Date.now() + CACHE_TTL_MS };
    log.info({ event: 'api.catalog.ok', count: sorted.length, rate });
    return NextResponse.json({ ok: true, services: sorted }, { status: 200 });
  } catch (err) {
    log.error({ event: 'api.catalog.failed', err });
    Sentry.captureException(err, { tags: { source: 'api.catalog' } });
    return NextResponse.json(
      { ok: false, error: 'catalog_unavailable' },
      { status: 503 },
    );
  }
}
