import 'server-only';

import { getDb, listActiveServices } from '@oplati/db';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { resolveUsdtRubRate } from '@/lib/loveandpay/rates';

import { buildCatalogService, sortCatalog, type CatalogService } from './build';

/**
 * Загрузка витрины кнопочного флоу (активные сервисы с тарифами и рублёвой
 * оценкой «к оплате») — единый источник для веб-чата (`GET /api/catalog`) и
 * Telegram-бота (кнопочный каталог). Ноль AI-токенов.
 *
 * Кэш — module-level (5 мин): бережёт вызов курса L&P и запрос к БД. Дрейф
 * витринной цены ≤ TTL не страшен — финальная сумма фиксируется заново
 * в `proposeFromCatalog`/`propose_order`. Кэш в памяти инстанса, не общий
 * между регионами — для каталога это норм.
 */

const log = childLogger('catalog.load');

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { services: CatalogService[]; expiresAt: number } | null = null;

/**
 * Возвращает отсортированную витрину. Бросает при недоступности БД/курса —
 * caller (API-route или бот) решает, как деградировать.
 */
export async function loadCatalog(): Promise<CatalogService[]> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.services;
  }

  const db = getDb();
  const [rows, rate] = await Promise.all([listActiveServices(db), resolveUsdtRubRate()]);
  const commissionPercent = serverEnv.COMMISSION_PERCENT;
  const minOrderKopecks = serverEnv.LOVEANDPAY_MIN_AMOUNT_RUB * 100;

  const services: CatalogService[] = [];
  for (const r of rows) {
    const svc = buildCatalogService(r, rate, commissionPercent, minOrderKopecks);
    if (svc) {
      services.push(svc);
    } else {
      // Сервис активен, но показать нечего (битая policy / нет USD-тарифов) —
      // владельцу важно это видеть, иначе сервис молча выпадет из витрины.
      log.warn({ event: 'catalog.load.service_skipped', slug: r.slug });
    }
  }

  const sorted = sortCatalog(services);
  cache = { services: sorted, expiresAt: Date.now() + CACHE_TTL_MS };
  log.info({ event: 'catalog.load.ok', count: sorted.length, rate });
  return sorted;
}

/**
 * Находит сервис витрины по slug (использует тот же кэш, что `loadCatalog`).
 * Удобно боту для резолва выбранного сервиса/тарифа по callback_data.
 */
export async function findCatalogService(slug: string): Promise<CatalogService | null> {
  const services = await loadCatalog();
  return services.find((s) => s.slug === slug) ?? null;
}
