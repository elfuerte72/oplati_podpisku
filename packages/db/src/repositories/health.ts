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
