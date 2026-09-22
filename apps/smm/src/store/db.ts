import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncClass } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// `node:sqlite` грузится через createRequire, а не обычным import: модуль
// доступен ТОЛЬКО с префиксом `node:`, и поэтому его нет в `builtinModules`,
// по которому vite (а значит и vitest) решает, встроенный ли это модуль. С
// прямым импортом тесты падают на «Failed to load url sqlite», хотя сам node
// его знает. Тип берётся обычным `import type` — он стирается при сборке.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncClass;
};

/**
 * Единственное место, которое знает про `node:sqlite`. Модуль в Node 24 имеет
 * статус release candidate, поэтому обёртка узкая: замена на `better-sqlite3`
 * будет правкой одного файла, а не поиском вызовов по всему боту.
 */

export type SqlValue = string | number | null;

export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): { changes: number };
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: SqlValue[]): T[];
  /**
   * Транзакция. Вложенный вызов не открывает вторую (SQLite их не умеет) —
   * переиспользует текущую, поэтому репозитории можно свободно складывать:
   * переход поста и строка решения обязаны быть в ОДНОЙ транзакции.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

function rows<T>(raw: unknown[]): T[] {
  // node:sqlite отдаёт объекты с null-прототипом: в тестах и при JSON.stringify
  // это лишний источник сюрпризов, поэтому возвращаем обычные объекты.
  return raw.map((row) => ({ ...(row as object) }) as T);
}

export function openDb(path: string): Db {
  const raw = new DatabaseSync(path);
  // WAL — чтобы чтение не ждало запись; таймаут — чтобы вместо SQLITE_BUSY
  // запрос подождал. Процесс у бота один, но тикеры и бот пишут вперемешку.
  // Для :memory: WAL не поддерживается, и это не повод падать.
  if (path !== ':memory:') raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec('PRAGMA foreign_keys = ON');

  let depth = 0;

  const db: Db = {
    exec(sql) {
      raw.exec(sql);
    },
    run(sql, ...params) {
      const result = raw.prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    },
    get<T>(sql: string, ...params: SqlValue[]) {
      const row = raw.prepare(sql).get(...params);
      return row === undefined ? undefined : ({ ...(row as object) } as T);
    },
    all<T>(sql: string, ...params: SqlValue[]) {
      return rows<T>(raw.prepare(sql).all(...params));
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      raw.exec('BEGIN');
      depth += 1;
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      } finally {
        depth -= 1;
      }
    },
    close() {
      raw.close();
    },
  };

  return db;
}

export interface AppliedMigration {
  readonly name: string;
  readonly appliedAt: string;
}

/**
 * Forward-only миграции файлами, журнал в таблице `migrations`. Применяются при
 * старте: у бота нет отдельного шага деплоя, и «деплой не применил миграции» —
 * ровно тот инцидент, который стоил проду отказа первого счёта Freekassa.
 * Повторный запуск идемпотентен: применяется то, чего нет в журнале.
 */
export function migrate(db: Db, now: () => Date = () => new Date()): AppliedMigration[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );
  const done = new Set(db.all<{ name: string }>('SELECT name FROM migrations').map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const applied: AppliedMigration[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const appliedAt = now().toISOString();
    // Каждый файл — своя транзакция: упавшая миграция не уносит применённые,
    // а журнал пишется в ней же, иначе он разошёлся бы со схемой.
    db.transaction(() => {
      db.exec(sql);
      db.run('INSERT INTO migrations (name, applied_at) VALUES (?, ?)', file, appliedAt);
    });
    applied.push({ name: file, appliedAt });
  }
  return applied;
}
