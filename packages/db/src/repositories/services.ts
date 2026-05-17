import { eq, sql } from 'drizzle-orm';

import { services } from '../schema.ts';
import type { DB } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Репозиторий каталога. Сервисы — публичные данные, RLS на таблице не включён
 * (см. schema.ts → таблица services без `.enableRLS()`). Поэтому функции тут
 * можно дёргать от любого роли; в продакшене это будет supabase-server / admin.
 */

export type ServiceRow = typeof services.$inferSelect;

export type CatalogSearchItem = {
  id: string;
  slug: string;
  name: string;
  basePriceUsdCents: number;
  requiresKyc: boolean;
};

/**
 * Поиск активных сервисов по ILIKE на slug/name. Возвращает не более 10.
 *
 * Цена в USD-центах вытаскивается из `pricing_policy` jsonb по двум возможным
 * формам:
 *   - MVP-формат:   { type: 'fixed_usd', basePriceUsdCents: 2000 }
 *   - Текущий seed: { tiers: [{ originalAmount: 2000, currency: 'USD', ... }] }
 *
 * COALESCE даёт приоритет MVP-формату. Записи без цены отфильтровываются.
 */
export async function searchActiveServices(
  db: DB,
  query: string,
  log: RepoLogger = noopLogger,
): Promise<CatalogSearchItem[]> {
  const q = query.trim();
  if (!q) return [];
  const pattern = `%${q}%`;

  type Row = {
    id: string;
    slug: string;
    name: string;
    requires_kyc: boolean;
    base_price_usd_cents: number | null;
  };

  const rows = await db.execute<Row>(sql`
    SELECT
      id,
      slug,
      name,
      requires_kyc,
      COALESCE(
        (pricing_policy ->> 'basePriceUsdCents')::int,
        ((pricing_policy -> 'tiers' -> 0) ->> 'originalAmount')::int
      ) AS base_price_usd_cents
    FROM services
    WHERE is_active = true
      AND (name ILIKE ${pattern} OR slug ILIKE ${pattern})
    ORDER BY name
    LIMIT 10
  `);

  const items: CatalogSearchItem[] = rows
    .filter((r): r is Row & { base_price_usd_cents: number } => typeof r.base_price_usd_cents === 'number')
    .map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      basePriceUsdCents: r.base_price_usd_cents,
      requiresKyc: r.requires_kyc,
    }));

  log.info({ event: 'db.services.search', query: q, count: items.length });
  return items;
}

export async function getServiceById(db: DB, id: string): Promise<ServiceRow | null> {
  const rows = await db.select().from(services).where(eq(services.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getServiceBySlug(db: DB, slug: string): Promise<ServiceRow | null> {
  const rows = await db.select().from(services).where(eq(services.slug, slug)).limit(1);
  return rows[0] ?? null;
}
