# Переменные окружения

Все секреты — в Vercel Environment Variables (или `.env.local` для dev). Никогда не коммитить `.env.local`.

## Загрузка

- В dev: `apps/web/.env.local`
- В prod: Vercel Dashboard → Project → Settings → Environment Variables, раздельно для Production / Preview / Development
- Управление через CLI: `vercel env pull apps/web/.env.local`

## Полный список

### База данных

| Переменная | Где | Обязательно | Пример / формат |
|---|---|---|---|
| `DATABASE_URL` | Supabase → Settings → Database → Connection pooling (Transaction mode) | yes | `postgresql://postgres.xxx:pwd@aws-0-eu-central-1.pooler.supabase.com:6543/postgres` |
| `DATABASE_URL_DIRECT` | Supabase → Settings → Database → Connection pooling (Session mode) port 5432 | для миграций | `postgresql://...@...:5432/postgres` |
| `SUPABASE_URL` | Supabase → Settings → API → Project URL | yes | `https://xxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase → Settings → API → anon public | yes (клиент) | `eyJhbGci...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role | yes (server) | `eyJhbGci...` — **server only** |

### Telegram

| Переменная | Где | Обязательно |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather → `/newbot` или `/token` | yes |
| `TELEGRAM_WEBHOOK_SECRET` | сгенерировать случайную строку (64 символа) | yes |
| `TELEGRAM_OPERATORS_GROUP_ID` | id группы операторов с форумами, начинается с `-100` | yes (Sprint 2) |

### AI

| Переменная | Где | Обязательно |
|---|---|---|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys | yes |
| `ANTHROPIC_MODEL` | одна из доступных моделей | default `claude-opus-4-6` |

### Платежи

| Переменная | Где | Обязательно |
|---|---|---|
| `YOOKASSA_SHOP_ID` | YooKassa → кабинет → Настройки → Интеграция | Sprint 2 |
| `YOOKASSA_SECRET_KEY` | там же | Sprint 2 |
| `YOOKASSA_WEBHOOK_SECRET` | опционально, для HMAC подписи webhook | — |
| `CRYPTOBOT_TOKEN` | @CryptoBot → Crypto Pay → Create App | Sprint 2 |
| `CRYPTOBOT_WEBHOOK_SECRET` | авто-выводится из `CRYPTOBOT_TOKEN` (HMAC) | — |

### Observability

| Переменная | Где | Обязательно |
|---|---|---|
| `SENTRY_DSN` | Sentry → Settings → Projects → Client Keys | yes |
| `SENTRY_AUTH_TOKEN` | Sentry → Settings → Account → API → Auth Tokens | для source map upload в билде |
| `NEXT_PUBLIC_SENTRY_DSN` | тот же, но публичный | yes (клиент) |

### Rate limit

| Переменная | Где | Обязательно |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | Upstash Console → Redis DB → REST API | Sprint 3 |
| `UPSTASH_REDIS_REST_TOKEN` | там же | Sprint 3 |

### Trigger.dev

| Переменная | Где | Обязательно |
|---|---|---|
| `TRIGGER_API_KEY` | cloud.trigger.dev → Project → API Keys | Sprint 3 |
| `TRIGGER_API_URL` | default `https://api.trigger.dev` | — |

### Приложение

| Переменная | Обязательно | Комментарий |
|---|---|---|
| `APP_URL` | yes | `https://oplati.example.com` в prod, tunnel URL в dev |
| `NODE_ENV` | auto | `development` / `production` |

## Генерация секретов

Случайные строки для `TELEGRAM_WEBHOOK_SECRET` и подобных:
```bash
openssl rand -hex 32
# или
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Правила работы с секретами

1. **Никогда не коммитить `.env.local`** — уже в `.gitignore`
2. **Никогда не логировать `SUPABASE_SERVICE_ROLE_KEY`**, `ANTHROPIC_API_KEY`, `YOOKASSA_SECRET_KEY` — даже в Sentry breadcrumbs
3. **Ротация секретов** — при компрометации или раз в 6 мес; обновить в Vercel и перезапустить деплой
4. **Разные ключи для Preview и Production** (тестовые шопы YooKassa для Preview, боевые для Production)
5. **Client-only vars** — только те, что с префиксом `NEXT_PUBLIC_`. Всё остальное — server-only.

## Валидация на старте

При старте приложения (`apps/web/lib/env.ts`) — валидировать все обязательные env через Zod. Если чего-то не хватает — **краш приложения** с понятной ошибкой, а не silent fallback.

Пример:
```typescript
// apps/web/lib/env.ts — описание, AI-агент имплементирует сам
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1),
  // ...
});
export const env = envSchema.parse(process.env);
```
