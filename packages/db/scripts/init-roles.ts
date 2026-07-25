/**
 * Идемпотентное создание Supabase-совместимых ролей на ЧИСТОМ Postgres
 * (self-host/Dokploy, docs/dokploy-migration-plan.md Фаза 2.1).
 *
 * Запуск: `pnpm --filter @oplati/db db:init-roles` (грузит `.env` из корня;
 * для целевой БД переопределить `DATABASE_URL_DIRECT` в shell — тот же
 * приоритет, что у drizzle.config.ts, чтобы роли и миграции попали в ОДНУ БД).
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
  // Приоритет ОБЯЗАН совпадать с drizzle.config.ts (`DATABASE_URL_DIRECT ??
  // DATABASE_URL`): роли должны появиться в той же БД, куда пойдёт db:migrate.
  // Обратный порядок ронял сценарий из CLAUDE.md, где в shell переопределяют
  // только DATABASE_URL_DIRECT: роли создавались в БД из корневого .env
  // (вплоть до прод-Supabase, где DO-блок молча скипает и печатает
  // «roles ready»), а миграция 0010 падала на «role does not exist».
  const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL_DIRECT or DATABASE_URL must be set (see .env in repo root)');
  }

  // connect_timeout: без него недоступная БД вешает скрипт бесконечно, а он
  // стоит первым шагом деплоя на новый контур.
  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 10 });
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
