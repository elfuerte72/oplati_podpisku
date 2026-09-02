import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

import * as schema from './schema.ts';

/**
 * Имена таблиц и колонок из `schema.ts` — для канареечных тестов вне пакета
 * (словарь схемы AI-аналитика панели сверяется с реальной схемой, а не с
 * памятью автора). `drizzle-orm` у `apps/web` в зависимостях нет и не должно
 * быть, поэтому обход таблиц живёт здесь.
 */
export function listSchemaTables(): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const columns = Object.values(getTableColumns(value)).map((c) => c.name);
    out.set(getTableName(value), columns);
  }
  return out;
}
