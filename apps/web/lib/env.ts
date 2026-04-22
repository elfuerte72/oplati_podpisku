import { z } from 'zod';

/**
 * Env-валидация через Zod.
 *
 * - `serverEnv` — server-only переменные (секреты, DATABASE_URL, service_role).
 *   Использовать ТОЛЬКО из server-кода. При попытке импорта на клиенте сработает `import 'server-only'`.
 * - `clientEnv` — публичные `NEXT_PUBLIC_*`, доступны и на сервере, и в браузере.
 * - Оба объекта — **lazy** (геттер): парсинг идёт при первом обращении, а не на этапе
 *   импорта. Это спасает `next build` в CI/CD, когда `.env.local` отсутствует
 *   и build попадает на import-time evaluation.
 * - На старте приложения (`instrumentation.ts`) делаем явный `serverEnv` touch,
 *   чтобы падение было fail-fast, а не при первом запросе.
 *
 * Sprint-1 опциональные: Telegram/YooKassa/CryptoBot/Upstash — помечены `.optional()`.
 */

// -------------------------------------------------------------------------
// Хелперы для опциональных env-переменных
// -------------------------------------------------------------------------
//
// Проблема: в `.env.local` часто оставляют переменные как `KEY=` (пустая строка) —
// это значит «ещё не заполнил». Но Zod `.optional()` интерпретирует только `undefined`
// как «отсутствует»; пустая строка — это валидная строка, и она проваливает `.min(1)`
// или `.url()`. Итог: fail-fast срабатывает там, где не должен.
//
// Решение: preprocess `"" → undefined` перед валидацией. Тогда `.optional()` работает
// так, как ожидается. Подробности — см. patch 2026-04-22-23.xx.md.
//
// Этот хелпер — единственный правильный способ объявить опциональный env-string в проекте.

function optionalEnvString(inner: z.ZodTypeAny = z.string().min(1)): z.ZodType {
  return z.preprocess((v) => (v === '' ? undefined : v), inner.optional());
}

const optionalUrl = () => optionalEnvString(z.string().url());

// -------------------------------------------------------------------------
// Схемы
// -------------------------------------------------------------------------

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // App
  APP_URL: z.string().url(),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: optionalUrl(),
  DATABASE_URL_DIRECT: optionalUrl(),

  // AI (Sprint 1.5 — Telegram + AI v1; на Sprint 1 ещё не используется)
  ANTHROPIC_API_KEY: optionalEnvString(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-6'),

  // Telegram (Sprint 1.5)
  TELEGRAM_BOT_TOKEN: optionalEnvString(),
  TELEGRAM_WEBHOOK_SECRET: optionalEnvString(),
  TELEGRAM_OPERATORS_GROUP_ID: optionalEnvString(),

  // Платежи (Sprint 2)
  YOOKASSA_SHOP_ID: optionalEnvString(),
  YOOKASSA_SECRET_KEY: optionalEnvString(),
  YOOKASSA_WEBHOOK_SECRET: optionalEnvString(),
  CRYPTOBOT_TOKEN: optionalEnvString(),
  CRYPTOBOT_WEBHOOK_SECRET: optionalEnvString(),

  // Rate limit (Sprint 3)
  UPSTASH_REDIS_REST_URL: optionalUrl(),
  UPSTASH_REDIS_REST_TOKEN: optionalEnvString(),

  // Trigger.dev (Sprint 3)
  TRIGGER_API_KEY: optionalEnvString(),
  TRIGGER_API_URL: z.string().url().default('https://api.trigger.dev'),

  // Observability
  SENTRY_DSN: optionalUrl(),
  SENTRY_AUTH_TOKEN: optionalEnvString(),

  // Vercel runtime (приходит автоматически)
  VERCEL_ENV: z.enum(['development', 'preview', 'production']).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),
});

const clientEnvSchema = z.object({
  NEXT_PUBLIC_SENTRY_DSN: optionalUrl(),
  NEXT_PUBLIC_APP_URL: optionalUrl(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type ClientEnv = z.infer<typeof clientEnvSchema>;

// -------------------------------------------------------------------------
// Lazy-парсинг
// -------------------------------------------------------------------------

let cachedServerEnv: ServerEnv | null = null;
let cachedClientEnv: ClientEnv | null = null;

function formatIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

/**
 * Доступ к валидированным server-переменным.
 * Бросает читаемую ошибку при отсутствии обязательных ключей.
 */
export function getServerEnv(): ServerEnv {
  if (cachedServerEnv) return cachedServerEnv;

  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = `Invalid server env:\n${formatIssues(parsed.error.issues)}`;
    console.error(msg);
    throw new Error(msg);
  }
  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

export function getClientEnv(): ClientEnv {
  if (cachedClientEnv) return cachedClientEnv;

  // В браузере process.env содержит только NEXT_PUBLIC_* — inline на build-time.
  const source = {
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  };
  const parsed = clientEnvSchema.safeParse(source);
  if (!parsed.success) {
    const msg = `Invalid client env:\n${formatIssues(parsed.error.issues)}`;
    console.error(msg);
    throw new Error(msg);
  }
  cachedClientEnv = parsed.data;
  return cachedClientEnv;
}

/** Proxy с ленивым разрешением — можно писать `serverEnv.SUPABASE_URL`. */
export const serverEnv = new Proxy({} as ServerEnv, {
  get(_target, key: string | symbol) {
    return getServerEnv()[key as keyof ServerEnv];
  },
}) as ServerEnv;

export const clientEnv = new Proxy({} as ClientEnv, {
  get(_target, key: string | symbol) {
    return getClientEnv()[key as keyof ClientEnv];
  },
}) as ClientEnv;
