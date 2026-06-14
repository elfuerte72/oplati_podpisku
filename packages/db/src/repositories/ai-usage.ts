import { eq, sql } from 'drizzle-orm';

import { aiUsageDaily } from '../schema.ts';
import type { DB } from '../index.ts';

/**
 * Репозиторий дневного счётчика AI-расходов (`ai_usage_daily`).
 *
 * Назначение — глобальный дневной токен-бюджет: каждый ответ агента добавляет
 * свой usage в счётчик текущего UTC-дня, а перед запуском агента проверяется
 * порог (логика весов и порога — apps/web/lib/ai/budget.ts, здесь только
 * хранение). Инкремент атомарный (одна строка на день, UPSERT), поэтому
 * параллельные запросы из нескольких serverless-инстансов не теряют данные.
 */

export type AiUsageDelta = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchRequests: number;
};

export type AiUsageTotals = AiUsageDelta & { requests: number };

/** Ключ дня по UTC ('YYYY-MM-DD') — сутки бюджета сбрасываются в полночь UTC. */
export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Прибавить usage одного ответа агента к счётчику дня (+1 к requests).
 * Возвращает новые суммарные значения дня — caller детектит пересечение порога.
 */
export async function recordAiUsageDelta(
  db: DB,
  day: string,
  delta: AiUsageDelta,
): Promise<AiUsageTotals> {
  const rows = await db
    .insert(aiUsageDaily)
    .values({ day, requests: 1, ...delta })
    .onConflictDoUpdate({
      target: aiUsageDaily.day,
      set: {
        requests: sql`${aiUsageDaily.requests} + 1`,
        inputTokens: sql`${aiUsageDaily.inputTokens} + ${delta.inputTokens}`,
        outputTokens: sql`${aiUsageDaily.outputTokens} + ${delta.outputTokens}`,
        cacheReadTokens: sql`${aiUsageDaily.cacheReadTokens} + ${delta.cacheReadTokens}`,
        cacheWriteTokens: sql`${aiUsageDaily.cacheWriteTokens} + ${delta.cacheWriteTokens}`,
        webSearchRequests: sql`${aiUsageDaily.webSearchRequests} + ${delta.webSearchRequests}`,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('recordAiUsageDelta: upsert returned no row');
  return {
    requests: row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    webSearchRequests: row.webSearchRequests,
  };
}

/** Суммарный usage за день; `null` — за день ещё не было ни одного запроса. */
export async function getAiUsageForDay(db: DB, day: string): Promise<AiUsageTotals | null> {
  const rows = await db.select().from(aiUsageDaily).where(eq(aiUsageDaily.day, day)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    requests: row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    webSearchRequests: row.webSearchRequests,
  };
}
