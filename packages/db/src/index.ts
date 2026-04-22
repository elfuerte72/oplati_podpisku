import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

export * from './schema.ts';

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
