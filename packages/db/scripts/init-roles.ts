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

import { bootstrapRolesSql, BOOTSTRAP_ROLES } from '../src/bootstrap-roles.ts';

/**
 * Свой pino здесь был бы pino БЕЗ redact-листа приложения: `logger.error({ err })`
 * сериализует ошибку клиента `postgres` целиком, а в ней — строка подключения с
 * паролем (C-5). Скрипт разовый и консольный, полноценный логгер ему не нужен,
 * поэтому печатаем только то, что сами сформировали: имя ошибки и сообщение,
 * без объекта и без стека драйвера.
 */
function fail(err: unknown): never {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`init-roles failed: ${name}: ${message}\n`);
  process.exit(1);
}

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
    await sql.unsafe(bootstrapRolesSql());
    const expected = BOOTSTRAP_ROLES.map((r) => r.name);
    const roles = await sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles
      WHERE rolname = ANY(${expected})
      ORDER BY rolname
    `;
    process.stdout.write(`roles ready: ${roles.map((r) => r.rolname).join(', ')}\n`);
  } finally {
    await sql.end();
  }
}

main().catch(fail);
