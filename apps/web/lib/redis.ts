import 'server-only';

import { serverEnv } from './env.server.ts';

/**
 * Откуда берутся реквизиты Redis. Одна точка на всех потребителей
 * (`ratelimit.ts`, `dedup.ts`) — раньше эта развилка была скопирована дословно,
 * и добавление третьего имени переменной пришлось бы вносить в оба места.
 *
 * Приоритет ручной конвенции `UPSTASH_*`, фолбэк на `KV_REST_API_*` — имена,
 * которые инжектит интеграция Upstash через Vercel Marketplace. Не заданы →
 * `null`, и каждый потребитель сам решает, что это значит (лимит — fail-open,
 * дедуп — тоже fail-open, но по своей причине).
 */
export function redisCredentialsFromEnv(): { url: string; token: string } | null {
  const url = serverEnv.UPSTASH_REDIS_REST_URL ?? serverEnv.KV_REST_API_URL;
  const token = serverEnv.UPSTASH_REDIS_REST_TOKEN ?? serverEnv.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}
