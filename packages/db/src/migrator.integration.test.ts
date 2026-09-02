import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';

import { bootstrapRolesSql } from './bootstrap-roles.ts';
import * as schema from './schema.ts';

/**
 * Журнал миграций проходит НАСТОЯЩИМ drizzle-мигратором — не `client.exec`.
 *
 * Разница принципиальна и один раз уже стоила бы выката. `PgDialect.migrate`
 * оборачивает в ОДНУ транзакцию ВСЕ ожидающие миграции разом, а не каждый файл
 * по отдельности:
 *
 * ```js
 * await session.transaction(async (tx) => {
 *   for await (const migration of migrations) { ... }
 * });
 * ```
 *
 * Из этого следуют две ловушки, которые `client.exec` (по файлу, автокоммит)
 * не воспроизводит НИКОГДА:
 *
 *   1. `ALTER TYPE ... ADD VALUE` к существующему типу + использование этого
 *      значения падают с `unsafe use of new value`, даже если разнесены по
 *      разным файлам, — раз оба файла ждут применения;
 *   2. проявляется это только при ИНКРЕМЕНТАЛЬНОМ обновлении: на пустой базе
 *      сам тип тоже создаётся в этой транзакции, и запрет не действует. То есть
 *      прогон «с нуля» зелёный, а обновление живой dev-базы падает.
 *
 * Поэтому тест намеренно строит базу в ДВА захода: сначала накатывает всё, кроме
 * последних миграций, коммитит — и только потом зовёт мигратора.
 */

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

describe('журнал миграций под настоящим drizzle-мигратором', () => {
  it('инкрементальное обновление применяет хвост журнала одной транзакцией и не падает', async () => {
    const files = migrationFiles();
    // Хвост — от 0041 (пересоздание enum) до конца журнала: в него попадает и
    // соседний файл той же транзакции (ловушка «значение enum из соседнего
    // файла»), и каждая новая миграция — она обязана применяться поверх живой
    // базы одной транзакцией с остальным хвостом, а не только с нуля.
    const tailStart = files.findIndex((f) => f.startsWith('0041_'));
    expect(tailStart).toBeGreaterThan(0);
    const head = files.slice(0, tailStart);
    expect(files.length - head.length).toBeGreaterThanOrEqual(2);

    const client = new PGlite();
    await client.exec(bootstrapRolesSql());
    for (const file of head) {
      await client.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }

    // Журнал мигратора заполняем вручную — база уже накатана «до», и мигратор
    // обязан считать эти миграции применёнными, иначе он погонит их повторно.
    const db = drizzle(client, { schema });
    await client.exec(`
      CREATE SCHEMA IF NOT EXISTS drizzle;
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
      );
    `);
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { tag: string; when: number }[] };
    const appliedUpTo = journal.entries.filter((e) => head.some((f) => f.startsWith(e.tag)));
    const lastApplied = appliedUpTo[appliedUpTo.length - 1];
    if (!lastApplied) throw new Error('не нашли, до какой миграции накатана база');
    await client.exec(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
       VALUES ('bootstrap', ${lastApplied.when})`,
    );

    // Живые строки со старым дефолтом — иначе backfill нечего переносить, и
    // «unsafe use of new value» может не сработать на пустой таблице.
    const userRows = await client.query<{ id: string }>(
      `INSERT INTO users (telegram_id) VALUES ('tg-migrator-1') RETURNING id`,
    );
    const userId = userRows.rows[0]?.id;
    if (!userId) throw new Error('не удалось создать пользователя');
    await client.query(
      `INSERT INTO conversations (user_id, channel, handoff_mode) VALUES ($1, 'telegram', 'ai')`,
      [userId],
    );

    await expect(migrate(db, { migrationsFolder: MIGRATIONS_DIR })).resolves.toBeUndefined();

    const modes = await db.execute<{ handoff_mode: string }>(
      sql`SELECT handoff_mode FROM conversations`,
    );
    const rows = Array.isArray(modes) ? modes : (modes as { rows: { handoff_mode: string }[] }).rows;
    expect(rows.map((r) => r.handoff_mode)).toEqual(['idle']);
  });

  it('ловушка реальна: ADD VALUE к существующему типу + его использование в ОДНОЙ транзакции падают', async () => {
    // Доказательство того, ради чего миграция 0041 пересоздаёт тип, а не
    // расширяет его. Без этого теста обоснование в шапке миграции — фольклор,
    // и следующий, кто «упростит» её обратно на `ALTER TYPE ADD VALUE`,
    // получит зелёный прогон и красный `db:migrate` на dev-базе.
    const client = new PGlite();
    // Тип создан и ЗАКОММИЧЕН отдельно — как `handoff_mode` из миграции 0000
    // на любой уже накатанной базе.
    await client.exec(`CREATE TYPE trap_mode AS ENUM ('ai', 'operator');`);
    await client.exec(`CREATE TABLE trap (mode trap_mode NOT NULL DEFAULT 'ai');`);
    await client.exec(`INSERT INTO trap (mode) VALUES ('ai');`);

    // Пооператорно, а не одним скриптом: после отказа транзакция уходит в
    // aborted, и следующая команда рапортует уже про это — настоящую причину
    // было бы не видно.
    await client.exec('BEGIN;');
    await client.exec(`ALTER TYPE trap_mode ADD VALUE IF NOT EXISTS 'idle' BEFORE 'ai';`);
    await expect(
      client.exec(`UPDATE trap SET mode = 'idle' WHERE mode = 'ai';`),
    ).rejects.toThrow(/unsafe use of new value/i);
    await client.exec('ROLLBACK;');

    // А пересоздание типа в той же транзакции — проходит: запрет касается
    // значений, добавленных к типу, который существовал ДО транзакции.
    await client.exec(`
      BEGIN;
      ALTER TABLE trap ALTER COLUMN mode DROP DEFAULT;
      ALTER TYPE trap_mode RENAME TO trap_mode_old;
      CREATE TYPE trap_mode AS ENUM ('idle', 'ai', 'operator');
      ALTER TABLE trap ALTER COLUMN mode TYPE trap_mode USING mode::text::trap_mode;
      DROP TYPE trap_mode_old;
      ALTER TABLE trap ALTER COLUMN mode SET DEFAULT 'idle';
      UPDATE trap SET mode = 'idle' WHERE mode = 'ai';
      COMMIT;
    `);

    const after = await client.query<{ mode: string }>(`SELECT mode FROM trap`);
    expect(after.rows.map((r) => r.mode)).toEqual(['idle']);
  });
});
