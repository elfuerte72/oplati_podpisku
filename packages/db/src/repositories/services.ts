import { eq, sql } from 'drizzle-orm';

import { services } from '../schema.ts';
import type { DB } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Репозиторий каталога. Сервисы — публичные данные, RLS на таблице не включён
 * (см. schema.ts → таблица services без `.enableRLS()`). Поэтому функции тут
 * можно дёргать от любого роли; в продакшене это будет supabase-server / admin.
 *
 * Цены НЕ возвращаются — каталог хранит только реестр поддерживаемых сервисов
 * (slug, name, requiresKyc). Актуальную цену AI достаёт через web_search tool
 * перед propose_order. Поле `pricing_policy` в БД остаётся как legacy данные;
 * search-результат его не использует и не возвращает.
 */

export type ServiceRow = typeof services.$inferSelect;

export type CatalogSearchItem = {
  id: string;
  slug: string;
  name: string;
  requiresKyc: boolean;
};

/**
 * Поиск активных сервисов по ILIKE на slug/name. Возвращает не более 10.
 * Цена не возвращается — её AI достаёт web_search'ем.
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
  };

  const rows = await db.execute<Row>(sql`
    SELECT id, slug, name, requires_kyc
    FROM services
    WHERE is_active = true
      AND (name ILIKE ${pattern} OR slug ILIKE ${pattern})
    ORDER BY name
    LIMIT 10
  `);

  const items: CatalogSearchItem[] = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
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
