import { eq, inArray, sql } from 'drizzle-orm';

import { services } from '../schema.ts';
import type { DB } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Репозиторий каталога. Сервисы — публичные данные на чтение, но запись закрыта
 * RLS/grants и должна идти только через service role / прямой server-side DB.
 *
 * Цены: у AI-пути их по-прежнему НЕТ — search-результат отдаёт только реестр
 * (slug, name, requiresKyc), актуальную цену агент достаёт через web_search.
 * Для кнопочного веб-флоу (решение владельца 2026-06-12) источник цены —
 * `pricing_policy.tiers[].originalAmount` (USD-центы, поддерживает владелец);
 * полные строки отдаёт `listActiveServices`.
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

/**
 * Все активные сервисы целиком (включая pricing_policy) — для кнопочного
 * каталога веб-чата. Порядок отображения задаёт вызывающая сторона.
 */
export async function listActiveServices(db: DB): Promise<ServiceRow[]> {
  return db.select().from(services).where(eq(services.isActive, true));
}

export async function getServiceById(db: DB, id: string): Promise<ServiceRow | null> {
  const rows = await db.select().from(services).where(eq(services.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getServiceBySlug(db: DB, slug: string): Promise<ServiceRow | null> {
  const rows = await db.select().from(services).where(eq(services.slug, slug)).limit(1);
  return rows[0] ?? null;
}

/**
 * Сервисы по набору id одним запросом — для списка заказов в кабинете
 * (резолв названий без N+1). Пустой вход → пустой результат.
 */
export async function getServicesByIds(db: DB, ids: string[]): Promise<ServiceRow[]> {
  if (ids.length === 0) return [];
  return await db.select().from(services).where(inArray(services.id, ids));
}
