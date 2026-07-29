import { sql } from 'drizzle-orm';

import type { DB } from '../index.ts';

/**
 * Лёгкая проба БД (`SELECT 1`). Два применения:
 *   - keep-alive cron — не давать Supabase free-tier уходить в auto-pause
 *     (см. post-mortem 2026-06-02: пауза БД молча превращала бота в амнезика);
 *   - health-проба — на недоступность БД отдаём явный сигнал, а не зелёный 200.
 *
 * Бросает при недоступности соединения (caller решает, алертить или нет).
 * Сознательно НЕ ловит ошибку внутри — «БД недоступна» это и есть полезный сигнал.
 */
export async function pingDb(db: DB): Promise<void> {
  await db.execute<{ ping: number }>(sql`SELECT 1 AS ping`);
}

/** Состояние журнала миграций drizzle в живой БД. */
export type AppliedMigrations = {
  /** Сколько миграций отмечено применёнными. */
  count: number;
  /**
   * `created_at` последней записи. Drizzle пишет туда `when` из
   * `migrations/meta/_journal.json`, поэтому значение напрямую сравнимо с
   * журналом в репозитории — сверять хеши файлов для этого не нужно.
   */
  latestWhen: number | null;
};

/**
 * Читает журнал применённых миграций.
 *
 * Нужно, чтобы поймать расхождение «код уехал, миграция нет» — схему, которая
 * не ловится ничем: деплой зелёный, `/api/health` здоров, а первый же клиент
 * получает `relation ... does not exist` (инцидент 2026-07-28 с
 * `freekassa_nonce`, docs/incidents.md).
 *
 * Таблицы может не быть вовсе (свежая БД, куда ни разу не гоняли `db:migrate`),
 * и это не ошибка соединения — возвращаем нули, а решение принимает вызывающий.
 */
export async function getAppliedMigrations(db: DB): Promise<AppliedMigrations> {
  const rows = await db.execute<{ count: string | number; latest: string | number | null }>(sql`
    SELECT count(*) AS count, max(created_at) AS latest
    FROM drizzle.__drizzle_migrations
  `);
  const row = rows[0];
  if (!row) return { count: 0, latestWhen: null };
  return {
    count: Number(row.count),
    latestWhen: row.latest === null ? null : Number(row.latest),
  };
}
