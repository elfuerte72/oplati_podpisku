import 'server-only';

import { getDb, searchActiveServices } from '@oplati/db';
import type { CatalogItem } from '@oplati/agent';

import { childLogger } from '../logger.ts';

const log = childLogger('tool.search_catalog');

export async function searchCatalog(input: { query: string }): Promise<CatalogItem[]> {
  log.info({ event: 'tool.search_catalog.start', query: input.query });
  const db = getDb();
  const items = await searchActiveServices(db, input.query, log);
  log.info({ event: 'tool.search_catalog.ok', query: input.query, count: items.length });
  return items;
}
