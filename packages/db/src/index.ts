import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

export * from './schema.ts';
export * from './repositories/index.ts';

let _client: ReturnType<typeof postgres> | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb() {
  if (_db) return _db;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  _client = postgres(url, {
    // Supabase pooler: prepare=false для pgbouncer в transaction mode
    prepare: false,
    max: 10,
  });
  _db = drizzle(_client, { schema });
  return _db;
}

export type DB = ReturnType<typeof getDb>;

/**
 * Транзакционный контекст drizzle (`db.transaction(async (tx) => ...)`).
 * Репозитории, участвующие в общих транзакциях с вызывающим кодом (например,
 * claim платежа + переход заказа в processInvoicePaid — атомарно, иначе сбой
 * между ними оставляет payment succeeded при «неоплаченном» заказе), принимают
 * `DBLike`: и обычный клиент, и tx.
 */
export type DBTx = Parameters<Parameters<DB['transaction']>[0]>[0];
export type DBLike = DB | DBTx;

export { listSchemaTables } from './schema-meta.ts';

export {
  pgliteReadOnlyExecutor,
  runReadOnlyQuery,
  wrapReadOnlyQuery,
  type ReadOnlyExecutor,
  type ReadOnlyQueryOptions,
  type ReadOnlyQueryResult,
} from './readonly-query.ts';
