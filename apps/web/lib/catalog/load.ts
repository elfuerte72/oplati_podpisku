import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, listActiveServices } from '@oplati/db';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { resolveUsdtRubRate } from '@/lib/rapira/rates';

import { buildCatalogService, sortCatalog, type CatalogService } from './build';

/**
 * Загрузка витрины кнопочного флоу (активные сервисы с тарифами и рублёвой
 * оценкой «к оплате») — единый источник для веб-чата (`GET /api/catalog`) и
 * Telegram-бота (кнопочный каталог). Ноль AI-токенов.
 *
 * Кэш — module-level (5 мин): бережёт вызов курса Rapira и запрос к БД. Дрейф
 * витринной цены ≤ TTL не страшен — финальная сумма фиксируется заново
 * в `proposeFromCatalog`/`propose_order`. Кэш в памяти инстанса, не общий
 * между регионами — для каталога это норм.
 *
 * Три свойства сверх простого TTL, и все три нужны именно на всплеске трафика
 * (то есть ровно тогда, когда витрина важнее всего):
 *
 *  - **single-flight.** Кэш протух → десять одновременных посетителей давали
 *    десять параллельных запросов к БД и к Rapira. Теперь обновление идёт одно,
 *    остальные ждут его же промис.
 *  - **stale-while-error.** Источник упал → отдаём последнюю удачную витрину
 *    вместо ошибки. Устаревшие цены безопасны: сумма всё равно фиксируется
 *    заново при оформлении заказа, а пустой каталог — это потерянный клиент.
 *    Ограничено `STALE_FALLBACK_MS`, чтобы не показывать вчерашние цены вечно.
 *  - **backoff на отказе.** Пока источник лежит, не долбим его каждым запросом.
 */

const log = childLogger('catalog.load');

const CACHE_TTL_MS = 5 * 60 * 1000;
/** Сколько ещё можно отдавать протухшую витрину, если обновление падает. */
const STALE_FALLBACK_MS = 30 * 60 * 1000;
/** Пауза перед следующей попыткой после неудачи — чтобы не бить лежащий источник. */
const ERROR_BACKOFF_MS = 15 * 1000;

type CacheEntry = { services: CatalogService[]; expiresAt: number; staleUntil: number };

let cache: CacheEntry | null = null;
/** Идущее обновление: конкурирующие вызовы ждут его, а не запускают своё. */
let inFlight: Promise<CatalogService[]> | null = null;
let retryNotBefore = 0;
/** Чем упала последняя попытка — чтобы отдавать ту же ошибку во время backoff. */
let lastError: unknown = null;

/**
 * Возвращает отсортированную витрину. Бросает только если витрины нет вовсе
 * (первая загрузка при лежащей БД) либо последняя удачная слишком стара —
 * caller (API-route или бот) решает, как деградировать.
 */
export async function loadCatalog(): Promise<CatalogService[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.services;

  // Источник недавно отказал — не трогаем его до конца backoff. Проверка НЕ
  // завязана на наличие кэша: холодный старт при лежащей БД и отказ дольше
  // STALE_FALLBACK_MS — ровно те случаи, когда кэша нет, а долбить источник
  // каждым запросом хуже всего.
  if (now < retryNotBefore) {
    if (cache && now < cache.staleUntil) return cache.services;
    throw lastError ?? new Error('catalog: источник недоступен');
  }

  inFlight ??= refreshCatalog().finally(() => {
    inFlight = null;
  });
  return await inFlight;
}

async function refreshCatalog(): Promise<CatalogService[]> {
  try {
    const sorted = await loadFromSources();
    const now = Date.now();
    cache = { services: sorted, expiresAt: now + CACHE_TTL_MS, staleUntil: now + STALE_FALLBACK_MS };
    retryNotBefore = 0;
    lastError = null;
    return sorted;
  } catch (err) {
    retryNotBefore = Date.now() + ERROR_BACKOFF_MS;
    lastError = err;
    // Отдача протухшего — это деградация, а не норма: без Sentry лежащие БД или
    // Rapira были бы видны только как pino-warn и до 30 минут никем не замечены.
    Sentry.captureException(err, { tags: { source: 'catalog.load' } });
    if (cache && Date.now() < cache.staleUntil) {
      log.warn({ event: 'catalog.load.stale_served', err });
      return cache.services;
    }
    throw err;
  }
}

async function loadFromSources(): Promise<CatalogService[]> {
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
  log.info({ event: 'catalog.load.ok', count: sorted.length, rate });
  return sorted;
}

/** Сброс состояния между тестами (в проде не зовётся). */
export function resetCatalogCacheForTests(): void {
  cache = null;
  inFlight = null;
  retryNotBefore = 0;
  lastError = null;
}

/**
 * Находит сервис витрины по slug (использует тот же кэш, что `loadCatalog`).
 * Удобно боту для резолва выбранного сервиса/тарифа по callback_data.
 */
export async function findCatalogService(slug: string): Promise<CatalogService | null> {
  const services = await loadCatalog();
  return services.find((s) => s.slug === slug) ?? null;
}
