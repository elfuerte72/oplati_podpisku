/**
 * Идемпотентное создание Supabase-совместимых ролей на ЧИСТОМ Postgres
 * (self-host/Dokploy, docs/dokploy-migration-plan.md Фаза 2.1).
 *
 * Запуск: `pnpm --filter @oplati/db db:init-roles` (грузит `.env` из корня;
 * для целевой БД переопределить `DATABASE_URL` в shell — как у db:migrate).
 *
 * Зачем: миграции писались под Supabase, где роли `anon`/`authenticated`/
 * `service_role` существуют из коробки. Миграция `0010` делает
 * `GRANT ... TO anon, authenticated` (public-read каталога services) и на
 * чистом Postgres упала бы с «role does not exist». Скрипт гоняется ОДИН раз
 * ДО `db:migrate` — тот же приём, что в PGlite-интеграционных тестах
 * (`src/integration.test.ts` создаёт эти роли перед миграциями).
 *
 * Почему НЕ Drizzle-миграция: на Supabase роли уже есть, `CREATE ROLE` там
 * упал бы; условная логика в миграции против форвард-онли конвенции проекта.
 *
 * Семантика ролей повторяет Supabase:
 *   - `anon`/`authenticated` — NOLOGIN, подпадают под RLS (deny-by-default);
 *   - `service_role` — NOLOGIN + BYPASSRLS (server-код и так подключается
 *     суперюзером контейнера, но роль нужна для паритета grant'ов).
 * Идемпотентность — проверка pg_roles перед CREATE (DO-блок).
 */

import postgres from 'postgres';
import pino from 'pino';

const logger = pino({ name: 'init-roles' });

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_DIRECT;
  if (!url) {
    throw new Error('DATABASE_URL or DATABASE_URL_DIRECT must be set (see .env in repo root)');
  }

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await sql.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN BYPASSRLS;
        END IF;
      END
      $$;
    `);
    const roles = await sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles
      WHERE rolname IN ('anon', 'authenticated', 'service_role')
      ORDER BY rolname
    `;
    logger.info({ roles: roles.map((r) => r.rolname) }, 'roles ready');
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'init-roles failed');
  process.exit(1);
});
