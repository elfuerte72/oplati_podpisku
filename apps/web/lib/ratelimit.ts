import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

import { serverEnv } from './env.server.ts';
import { childLogger } from './logger.ts';

/**
 * Per-identity rate-limit на дорогие AI-эндпоинты (`/api/chat`, `/api/bot`).
 *
 * Зачем (мера B1 из docs/fix-plan.md): дневной токен-бюджет — глобальный, его
 * можно исчерпать на всех легитимных пользователей запросами одного абьюзера.
 * Лимит «на одного» режет такой DoS-на-бюджет ДО вызова роутера/агента.
 *
 * Хранилище — Upstash Redis (HTTP REST), НЕ Postgres: лимит продолжает работать,
 * даже когда Supabase недоступен (а именно тогда отключается бюджет — см.
 * apps/web/lib/ai/budget.ts). Sliding window.
 *
 * Конфигурация — env `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`,
 * либо `KV_REST_API_URL` + `KV_REST_API_TOKEN` (имена, которые инжектит
 * интеграция Upstash через Vercel Marketplace). Поддерживаем оба, приоритет —
 * UPSTASH_*. Не заданы → limiter выключен (fail-open): отдаём `allowed`, чтобы
 * не уронить продукт там, где Upstash ещё не подключён. Аварийный выключатель —
 * `RATE_LIMIT_DISABLED=1`.
 *
 * Fail-open и при ошибке самого Upstash: лучше пропустить запрос, чем уронить
 * чат; ошибка уходит в Sentry.
 */

const log = childLogger('ratelimit');

export type RateLimitResult = {
  /** Разрешить запрос. true и когда limiter выключен/недоступен (fail-open). */
  allowed: boolean;
  /** Сконфигурирован ли реальный backend (false → проверка не выполнялась). */
  configured: boolean;
  limit: number;
  remaining: number;
};

export type RateLimitName = 'web-chat' | 'telegram';

type LimiterConfig = { limit: number; windowSeconds: number };

// Окна подобраны под продукт (~50 заказов/день): живому пользователю хватает с
// запасом, абьюзеру — режет залп. Тюнится без изменения кода вызова.
const CONFIGS: Record<RateLimitName, LimiterConfig> = {
  'web-chat': { limit: 12, windowSeconds: 60 },
  telegram: { limit: 20, windowSeconds: 60 },
};

let cachedRedis: Redis | null = null;
const limiterCache = new Map<RateLimitName, Ratelimit>();

function isDisabled(): boolean {
  return process.env.RATE_LIMIT_DISABLED === '1' || process.env.RATE_LIMIT_DISABLED === 'true';
}

/** Ленивая инициализация Redis-клиента; null — если env не сконфигурирован. */
function getRedis(): Redis | null {
  if (cachedRedis) return cachedRedis;
  // Приоритет ручной конвенции UPSTASH_*, фолбэк на KV_REST_API_* от интеграции Vercel.
  const url = serverEnv.UPSTASH_REDIS_REST_URL ?? serverEnv.KV_REST_API_URL;
  const token = serverEnv.UPSTASH_REDIS_REST_TOKEN ?? serverEnv.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  cachedRedis = new Redis({ url, token });
  return cachedRedis;
}

function getLimiter(name: RateLimitName): Ratelimit | null {
  const cached = limiterCache.get(name);
  if (cached) return cached;
  const redis = getRedis();
  if (!redis) return null;
  const cfg = CONFIGS[name];
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(cfg.limit, `${cfg.windowSeconds} s`),
    prefix: `rl:${name}`,
    analytics: false,
  });
  limiterCache.set(name, limiter);
  return limiter;
}

/**
 * Проверка лимита для (name, identity). `identity` — IP (веб) или
 * telegram_id/chat_id (бот). Никогда не бросает.
 */
export async function checkRateLimit(
  name: RateLimitName,
  identity: string,
): Promise<RateLimitResult> {
  const cfg = CONFIGS[name];
  if (isDisabled()) {
    return { allowed: true, configured: false, limit: cfg.limit, remaining: cfg.limit };
  }

  const limiter = getLimiter(name);
  if (!limiter) {
    // Upstash не подключён — fail-open (не блокируем продукт).
    return { allowed: true, configured: false, limit: cfg.limit, remaining: cfg.limit };
  }

  try {
    const { success, limit, remaining } = await limiter.limit(identity);
    if (!success) {
      log.warn({ event: 'ratelimit.blocked', name, limit, remaining });
    }
    return { allowed: success, configured: true, limit, remaining };
  } catch (err) {
    // Ошибка backend'а — fail-open, но фиксируем в Sentry.
    log.error({ event: 'ratelimit.check_failed', name, err });
    Sentry.captureException(err, { tags: { source: 'ratelimit', name } });
    return { allowed: true, configured: false, limit: cfg.limit, remaining: cfg.limit };
  }
}
