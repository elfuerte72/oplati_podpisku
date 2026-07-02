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
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  // Для финансовой коммуникации стабильнее низкая температура; max_tokens
  // увеличен на 2048 (хватает на KYC-инструкции, длинные ссылки и пр.).
  ANTHROPIC_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.3),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().min(256).max(8192).default(2048),
  // Haiku-роутер перед основным агентом (packages/agent/src/router.ts).
  // Модель читается агентом напрямую из process.env (как ANTHROPIC_MODEL).
  ANTHROPIC_ROUTER_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  // Аварийный выключатель роутера: '1'/'true' — все сообщения идут сразу в агент.
  AI_ROUTER_DISABLED: z
    .preprocess((v) => v === '1' || v === 'true', z.boolean())
    .default(false),
  // Дневной глобальный бюджет AI во «взвешенных» токенах (эквивалент input-цены
  // Sonnet; веса и формула — apps/web/lib/ai/budget.ts). 3M ≈ $9/день.
  AI_DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(3_000_000),

  // Telegram (Sprint 1.5)
  TELEGRAM_BOT_TOKEN: optionalEnvString(),
  TELEGRAM_WEBHOOK_SECRET: optionalEnvString(),
  TELEGRAM_OPERATORS_GROUP_ID: optionalEnvString(),
  // Куда бот пересылает обращения из /support (interim-handoff, пока нет
  // forum-topics). Не задан → дефолт в коде (telegram_id владельца). Оператор
  // ОБЯЗАН один раз запустить бота (/start), иначе Telegram не даст слать ему DM.
  // Формат — числовой chat_id (может быть отрицательным для групп) или @username;
  // мусорное значение fail-fast на старте, а не молчаливым сбоем sendMessage.
  SUPPORT_OPERATOR_CHAT_ID: optionalEnvString(
    z.string().regex(/^(-?\d+|@[A-Za-z0-9_]{4,})$/, 'must be a numeric chat id or @username'),
  ),

  // Платежи (Sprint 2)
  YOOKASSA_SHOP_ID: optionalEnvString(),
  YOOKASSA_SECRET_KEY: optionalEnvString(),
  YOOKASSA_WEBHOOK_SECRET: optionalEnvString(),
  CRYPTOBOT_TOKEN: optionalEnvString(),
  CRYPTOBOT_WEBHOOK_SECRET: optionalEnvString(),

  // Love & Pay (MVP) — RUB-acquiring + USDT rates; preview = pk_test_*, prod = pk_live_*
  LOVEANDPAY_API_KEY: optionalEnvString(),
  LOVEANDPAY_SECRET_KEY: optionalEnvString(),
  LOVEANDPAY_WEBHOOK_SECRET: optionalEnvString(),
  LOVEANDPAY_BASE_URL: z.string().url().default('https://loveandpay.io/api/v2'),
  // Минимальная сумма счёта L&P в рублях (терминал KANYON не принимает < 500 ₽).
  // Ниже лимита `/api/payments/create` вернёт below_min_amount ДО вызова L&P,
  // чтобы не ловить INTERNAL_ERROR на стороне провайдера.
  LOVEANDPAY_MIN_AMOUNT_RUB: z.coerce.number().int().min(500).default(500),

  // app.pay.space (MVP) — выпуск виртуальных USD-карт
  PAYSPACE_API_KEY: optionalEnvString(),
  // accountId неявен в API-ключе и провайдеру не передаётся; оставлен для обратной
  // совместимости env, в коде НЕ используется (проверить и убрать после live-вызова).
  PAYSPACE_ACCOUNT_ID: optionalEnvString(),
  // HMAC-секрет подписи исходящих запросов (X-Signature). Задан в кабинете → подпись
  // обязательна для всех запросов.
  PAYSPACE_REQUEST_SECRET: optionalEnvString(),
  // Секрет проверки подписи входящих VCC-вебхуков (Шаг E; схема подписи D6).
  PAYSPACE_WEBHOOK_SECRET: optionalEnvString(),
  PAYSPACE_BASE_URL: z.string().url().default('https://app.pay.space/api/v1'),
  // Порог алёрта по балансу VCC-аккаунта (USD-центы): ниже — Sentry warning в
  // cron recycle-cards. Пополнение VCC — T+1, поэтому предупреждаем заранее.
  PAYSPACE_MIN_VCC_BALANCE_USD_CENTS: z.coerce.number().int().nonnegative().default(5000),
  // Буфер сверх USD-цены сервиса на сумму ВЫПУСКАЕМОЙ/пополняемой карты (проценты).
  // По умолчанию 0: карты американские, мерчантов оплачиваем в USD без НДС и FX
  // (клиента просим включить VPN США и вводить цену без налога), поэтому реальный
  // charge = витринная цена, запас не нужен. Закладывается ТОЛЬКО в сумму карты,
  // в цену клиенту НЕ входит. >0 ставить, если по реальным заказам charge окажется
  // выше цены (FX/VAT) — тогда неизрасходованный остаток вернётся на VCC при release.
  PAYSPACE_CARD_BUFFER_PERCENT: z.coerce.number().int().min(0).max(100).default(0),

  // Снапшот комиссии (10 = 10%); дефолт совпадает с константой в propose-order
  COMMISSION_PERCENT: z.coerce.number().int().min(0).max(50).default(10),

  // Реферальная (партнёрская) программа. Глобальный kill-switch: '1'/'true' —
  // захват реферера и начисления включены; по умолчанию ВЫКЛЮЧЕНО (фаза катится
  // поэтапно, см. plan.md). REFERRAL_MIN_PAYOUT_USD_CENTS — минимум на вывод
  // ($10 = 1000 центов), Этап D/E.
  REFERRAL_ENABLED: z
    .preprocess((v) => v === '1' || v === 'true', z.boolean())
    .default(false),
  REFERRAL_MIN_PAYOUT_USD_CENTS: z.coerce.number().int().positive().default(1000),

  // Fallback USDT→RUB курс, если L&P /rates временно недоступен (сейчас именно
  // так: договор по фикс-курсу не подписан → /rates отдаёт RATE_NOT_FOUND, и
  // ВСЕ заказы идут на этом fallback'е). Значение — актуальный рыночный курс в
  // рублях за 1 USDT; держать близко к реальному, пока L&P не оживёт (тогда
  // живой курс перекроет fallback сам).
  RATE_FALLBACK_USDT_RUB: z.coerce.number().positive().default(77),

  // Внутренний токен для self-call'ов из tool-handler в /api/payments/create
  INTERNAL_API_TOKEN: optionalEnvString(),

  // Секрет cron-endpoint'ов. Vercel Cron шлёт его как `Authorization: Bearer`.
  // Без него `authorizeCron` пускает только NODE_ENV=development (fail-closed
  // на preview/production). На проде задавать ОБЯЗАТЕЛЬНО.
  CRON_SECRET: optionalEnvString(),
  CRON_TOKEN: optionalEnvString(),

  // Алерты Sentry → Telegram (relay POST /api/alerts/sentry). Sentry alert rule
  // шлёт webhook с секретом в query (?s=<...>), endpoint пересылает алёрт в
  // Telegram через бота. SENTRY_ALERT_WEBHOOK_SECRET гейтит запрос (timing-safe);
  // ALERT_TELEGRAM_CHAT_ID — куда слать (telegram_id владельца или id группы
  // алёртов, где бот). Любой не задан → endpoint no-op (200).
  SENTRY_ALERT_WEBHOOK_SECRET: optionalEnvString(),
  ALERT_TELEGRAM_CHAT_ID: optionalEnvString(),

  // Rate limit (per-identity, мера B1). Backend — Upstash Redis (HTTP REST).
  // Не заданы URL/TOKEN → limiter выключен (fail-open). Аварийный выключатель —
  // RATE_LIMIT_DISABLED='1'/'true' (читается в lib/ratelimit.ts).
  // Имена UPSTASH_* — ручная конвенция; KV_REST_API_* — то, что инжектит
  // интеграция Upstash через Vercel Marketplace. Поддерживаем оба (lib/ratelimit.ts).
  UPSTASH_REDIS_REST_URL: optionalUrl(),
  UPSTASH_REDIS_REST_TOKEN: optionalEnvString(),
  KV_REST_API_URL: optionalUrl(),
  KV_REST_API_TOKEN: optionalEnvString(),
  RATE_LIMIT_DISABLED: z
    .preprocess((v) => v === '1' || v === 'true', z.boolean())
    .default(false),

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
