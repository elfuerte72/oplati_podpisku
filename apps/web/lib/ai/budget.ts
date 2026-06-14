import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getAiUsageForDay, getDb, recordAiUsageDelta, utcDayKey } from '@oplati/db';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';

/**
 * Дневной глобальный бюджет AI-расходов (мера 4 из docs/11.06.2026.md).
 *
 * Счётчик живёт в таблице `ai_usage_daily` (одна строка на UTC-день, атомарный
 * UPSERT-инкремент). Каждый ответ агента добавляет свой usage; перед запуском
 * агента оба канала (веб-чат, Telegram) зовут `isAiBudgetExceeded()` и при
 * превышении отвечают заготовленным текстом БЕЗ вызова Anthropic.
 *
 * Бюджет считается во «взвешенных» токенах — эквивалентах обычного
 * input-токена Sonnet ($3/M): output в 5 раз дороже, запись в кэш — 1.25x,
 * чтение из кэша — 0.1x, один web_search-запрос ($10/1000) ≈ 3334 токена.
 * Дефолт 3M взвешенных токенов ≈ $9/день; настройка — env AI_DAILY_TOKEN_BUDGET.
 *
 * Fail-open: недоступная БД не выключает агента, а ошибки записи не ломают
 * ответ пользователю. Это осознанный компромисс в пользу доступности — но НЕ
 * единственный слой защиты расходов: per-identity rate-limit (lib/ratelimit.ts,
 * backend Upstash) работает независимо от Postgres и режет DoS-на-бюджет, даже
 * когда этот счётчик недоступен. Плюс prepaid-баланс Anthropic как потолок.
 * Sentry-алерт уходит один раз — при пересечении порога, а не на каждый запрос.
 */

const log = childLogger('ai-budget');

// Веса стоимости относительно input-токена Sonnet 4.x ($3/M):
// output $15/M, cache write 1.25x, cache read 0.1x, web_search $10/1000 запросов.
const OUTPUT_TOKEN_WEIGHT = 5;
const CACHE_WRITE_WEIGHT = 1.25;
const CACHE_READ_WEIGHT = 0.1;
const WEB_SEARCH_REQUEST_WEIGHT = 3334;

export const BUDGET_EXCEEDED_TEXT =
  'Сейчас у нас очень высокая нагрузка, и я временно не отвечаю — извини. Загляни чуть позже, пожалуйста, я обязательно помогу с оплатой.';

/** Поля usage из ответа Anthropic, которые мы учитываем (структурно, без SDK-типов). */
export interface AgentUsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

interface WeightableUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchRequests: number;
}

/**
 * Сложить usage двух вызовов (Haiku-роутер + основной агент) для учёта одним
 * инкрементом счётчика. `null` входы допустимы (роутер выключен/упал).
 */
export function mergeUsage(
  a: AgentUsageLike | null | undefined,
  b: AgentUsageLike | null | undefined,
): AgentUsageLike | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens:
      (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    server_tool_use: {
      web_search_requests:
        (a.server_tool_use?.web_search_requests ?? 0) +
        (b.server_tool_use?.web_search_requests ?? 0),
    },
  };
}

/** Стоимость в эквивалентах input-токена Sonnet (см. веса выше). */
export function weightedTokens(t: WeightableUsage): number {
  return Math.round(
    t.inputTokens +
      t.outputTokens * OUTPUT_TOKEN_WEIGHT +
      t.cacheWriteTokens * CACHE_WRITE_WEIGHT +
      t.cacheReadTokens * CACHE_READ_WEIGHT +
      t.webSearchRequests * WEB_SEARCH_REQUEST_WEIGHT,
  );
}

/**
 * Проверка перед запуском агента: исчерпан ли дневной бюджет.
 * Fail-open: ошибка БД → false (агент работает), ошибка в Sentry.
 */
export async function isAiBudgetExceeded(): Promise<boolean> {
  try {
    const totals = await getAiUsageForDay(getDb(), utcDayKey());
    if (!totals) return false;
    const spent = weightedTokens(totals);
    const budget = serverEnv.AI_DAILY_TOKEN_BUDGET;
    if (spent < budget) return false;
    log.warn({ event: 'ai-budget.request_rejected', spent, budget, day: utcDayKey() });
    return true;
  } catch (err) {
    log.error({ event: 'ai-budget.check_failed', err });
    Sentry.captureException(err, { tags: { source: 'ai-budget', step: 'check' } });
    return false;
  }
}

/**
 * Записать usage одного ответа агента (включая Haiku-роутер) в счётчик дня.
 * Никогда не бросает. При пересечении порога — Sentry warning (один раз).
 */
export async function recordAgentUsage(usage: AgentUsageLike | null | undefined): Promise<void> {
  if (!usage) return;
  const delta: WeightableUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
  };
  try {
    const totals = await recordAiUsageDelta(getDb(), utcDayKey(), delta);
    const budget = serverEnv.AI_DAILY_TOKEN_BUDGET;
    const spent = weightedTokens(totals);
    const spentBefore = spent - weightedTokens(delta);
    if (spent >= budget && spentBefore < budget) {
      log.warn({ event: 'ai-budget.exceeded', spent, budget, day: utcDayKey() });
      Sentry.captureMessage('AI daily token budget exceeded', {
        level: 'warning',
        tags: { source: 'ai-budget' },
        extra: { spent, budget, day: utcDayKey(), totals },
      });
    }
  } catch (err) {
    log.error({ event: 'ai-budget.record_failed', err });
    Sentry.captureException(err, { tags: { source: 'ai-budget', step: 'record' } });
  }
}
