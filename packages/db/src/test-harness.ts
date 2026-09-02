import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import { bootstrapRolesSql } from './bootstrap-roles.ts';
import * as schema from './schema.ts';
import type { DB } from './index.ts';
import type { ReadOnlyExecutor } from './readonly-query.ts';

/**
 * Обвязка интеграционных тестов: РЕАЛЬНЫЙ Postgres (PGlite, WASM) с РЕАЛЬНЫМИ
 * миграциями из `migrations/`. Вынесена из `integration.test.ts`, чтобы второй
 * файл тестов не заводил свою копию бутстрапа: копия расходится с оригиналом
 * молча (не тот набор ролей, не тот способ прогона миграций) — и тесты начинают
 * проверять не тот контур, что едет в прод.
 *
 * Файл лежит в `src/`, но не заканчивается на `.test.ts` — vitest его не
 * подхватывает как набор тестов.
 */

/**
 * drizzle-драйверы расходятся в форме результата `db.execute()`: postgres-js
 * возвращает сами строки (RowList), PGlite — `{ rows }`. Репозитории написаны
 * под postgres-js и индексируют результат напрямую, поэтому в тестах
 * нормализуем execute (и рекурсивно — tx внутри transaction) до массива строк.
 */
export function normalizeExecute<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === 'execute') {
        return async (query: unknown) => {
          const orig = Reflect.get(t, prop, receiver) as (q: unknown) => Promise<unknown>;
          const res = await orig.call(t, query);
          return Array.isArray(res) ? res : (res as { rows: unknown[] }).rows;
        };
      }
      if (prop === 'transaction') {
        const orig = Reflect.get(t, prop, receiver) as (
          fn: (tx: object) => Promise<unknown>,
          cfg?: unknown,
        ) => Promise<unknown>;
        return (fn: (tx: object) => Promise<unknown>, cfg?: unknown) =>
          orig.call(t, (tx: object) => fn(normalizeExecute(tx)), cfg);
      }
      const value: unknown = Reflect.get(t, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });
}

/**
 * Поднимает PGlite и прогоняет по нему весь журнал миграций.
 *
 * Миграции гоняем через `client.exec` (simple query protocol): drizzle-migrator
 * шлёт чанки prepared statement'ами, а ранние hand-written миграции (0001 RLS
 * и т.п.) мультистейтментные без `--> statement-breakpoint` — редактировать
 * применённые миграции нельзя. `exec` исполняет файл как есть.
 *
 * Supabase-роли, на которые ссылаются RLS-политики и GRANT'ы миграций, создаём
 * ТЕМ ЖЕ DDL, что гоняет `db:init-roles` на боевом контуре (E-9).
 */
export async function createTestDb(
  opts: {
    /**
     * Остановиться перед миграцией с этим префиксом — чтобы наполнить базу
     * данными «как на проде» и доприменить остаток через `applyRemainingMigrations`.
     * Без этого backfill проверить нечем: миграции, применённые к ПУСТОЙ базе,
     * ничего не переносят, и тест зелен при любом UPDATE (в том числе забытом).
     */
    stopBefore?: string;
  } = {},
): Promise<{ db: DB; pg: PGlite; applyRemainingMigrations: () => Promise<void> }> {
  const client = new PGlite();
  await client.exec(bootstrapRolesSql());

  const dir = join(import.meta.dirname, '..', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const stopAt = opts.stopBefore ? files.findIndex((f) => f.startsWith(opts.stopBefore ?? '')) : -1;
  const head = stopAt >= 0 ? files.slice(0, stopAt) : files;
  const tail = stopAt >= 0 ? files.slice(stopAt) : [];

  for (const file of head) {
    await client.exec(readFileSync(join(dir, file), 'utf8'));
  }

  const applyRemainingMigrations = async () => {
    for (const file of tail) {
      await client.exec(readFileSync(join(dir, file), 'utf8'));
    }
  };

  const raw = drizzle(client, { schema });
  // У PGlite-драйвера другой HKT в типах, но runtime-API совпадает с
  // postgres-js — обоснованное сужение для тестовой обвязки.
  const db = normalizeExecute(raw) as unknown as DB;
  return { db, pg: client, applyRemainingMigrations };
}

/**
 * Исполнитель read-only запросов аналитика для тестов на PGlite — те же
 * страховки, что и у боевого (`postgresExecutor` в `readonly-query.ts`):
 * транзакция READ ONLY и `statement_timeout`. Живёт в харнесе, а не в
 * прод-модуле: боевому коду тестовый драйвер не нужен.
 */
export function pgliteReadOnlyExecutor(pg: PGlite): ReadOnlyExecutor {
  return {
    async run(sqlText, timeoutMs) {
      return pg.transaction(async (tx) => {
        await tx.exec('SET TRANSACTION READ ONLY');
        await tx.exec(`SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`);
        const res = await tx.query<unknown[]>(sqlText, [], { rowMode: 'array' });
        return { columns: res.fields.map((f) => f.name), rows: res.rows };
      });
    },
  };
}
