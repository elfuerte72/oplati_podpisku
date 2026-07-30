/**
 * Supabase-совместимые роли на чистом Postgres — ОДИН источник правды.
 *
 * Миграции писались под Supabase, где `anon`/`authenticated`/`service_role`
 * существуют из коробки: миграция 0010 делает `GRANT ... TO anon, authenticated`
 * (public-read каталога) и на голом Postgres упала бы с «role does not exist».
 *
 * Раньше набор ролей задавался ДВАЖДЫ и по-разному: `scripts/init-roles.ts`
 * создавал `service_role NOLOGIN BYPASSRLS`, а PGlite-тесты — просто
 * `CREATE ROLE service_role`. То есть интеграционные тесты проверяли не тот
 * контур, что едет в прод: `BYPASSRLS` — это ровно та привилегия, из-за которой
 * server-код видит данные при deny-by-default RLS (инвариант 8), и её
 * отсутствие в тестах делало бы зелёной регрессию, ломающую прод (E-9).
 *
 * Держать здесь, а не в миграции: на Supabase роли уже есть, `CREATE ROLE` там
 * упал бы, а условная логика в миграции противоречит forward-only конвенции.
 */

/** Роли и их атрибуты. Порядок стабилен — им же создаём в тестах. */
export const BOOTSTRAP_ROLES = [
  // Подпадают под RLS (deny-by-default): браузерный клиент не читает ничего,
  // кроме активного каталога по явной policy.
  { name: 'anon', attributes: 'NOLOGIN' },
  { name: 'authenticated', attributes: 'NOLOGIN' },
  // BYPASSRLS обязателен: на всех таблицах RLS включён и политик под обычную
  // роль нет, поэтому без него любой серверный запрос вернул бы ноль строк.
  { name: 'service_role', attributes: 'NOLOGIN BYPASSRLS' },
] as const;

/**
 * Идемпотентный DDL: DO-блок с проверкой `pg_roles` перед `CREATE`.
 * Прогоняется до `db:migrate` на новом контуре и перед миграциями в тестах.
 */
export function bootstrapRolesSql(): string {
  const branches = BOOTSTRAP_ROLES.map(
    (r) => `        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${r.name}') THEN
          CREATE ROLE ${r.name} ${r.attributes};
        END IF;`,
  ).join('\n');
  return `DO $$\nBEGIN\n${branches}\nEND\n$$;`;
}
