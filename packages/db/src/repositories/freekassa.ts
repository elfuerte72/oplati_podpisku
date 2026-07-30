import { sql } from 'drizzle-orm';

import type { DBLike } from '../index.ts';

/**
 * Монотонный `nonce` для запросов к API Freekassa.
 *
 * Провайдер требует «уникальный ID запроса, всегда больше предыдущего».
 * Источник — последовательность Postgres `freekassa_nonce` (миграция 0026):
 * `nextval` монотонен при любой параллельности, переживает перезапуск
 * контейнера и не зависит от часов узла.
 *
 * Почему НЕ `Date.now()`: два конкурентных `confirm_order` в одну миллисекунду
 * (реальный кейс — веб-вкладка + handoff заказа в боте после привязки Telegram)
 * получили бы одинаковый nonce, и второй запрос провайдер отверг бы.
 *
 * Гэпы в значениях допустимы: требование провайдера — «больше предыдущего», а
 * не «без пропусков», поэтому `nextval` вне транзакции (он и не откатывается).
 */
export async function nextFreekassaNonce(db: DBLike): Promise<number> {
  const rows = await db.execute<{ nonce: string | number }>(
    sql`select nextval('freekassa_nonce') as nonce`,
  );
  // postgres-js отдаёт bigint строкой (иначе потеря точности за 2^53).
  // Наши значения (~2e9) в Number укладываются с запасом; проверяем явно, чтобы
  // дрейф не превратился в молча округлённый nonce.
  const raw = rows[0]?.nonce;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`freekassa nonce: неожиданное значение последовательности (${String(raw)})`);
  }
  return value;
}
