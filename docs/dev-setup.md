# Dev Setup

Как запустить проект локально.

## Пререквизиты

### Установить инструменты

- **Node.js 24 LTS** — через [nvm](https://github.com/nvm-sh/nvm) или [fnm](https://github.com/Schniz/fnm)
  ```bash
  nvm install 24 && nvm use 24
  ```
- **pnpm 9.x**
  ```bash
  corepack enable && corepack prepare pnpm@9.12.0 --activate
  ```
- **Git** + настроенный SSH доступ к GitHub
- **ngrok** или **Cloudflare Tunnel** — для Telegram webhook

### Зарегистрировать аккаунты

- [Supabase](https://supabase.com) — бесплатно
- [Vercel](https://vercel.com) — бесплатно
- [Anthropic Console](https://console.anthropic.com) — получить API key, привязать биллинг
- [Sentry](https://sentry.io) — бесплатный тариф
- [Trigger.dev](https://trigger.dev) — бесплатный тариф (Sprint 3)
- [@BotFather](https://t.me/BotFather) — dev-бот отдельно от production
- YooKassa/CryptoBot — sandbox/testnet аккаунты (Sprint 2+)

## Первый запуск

### 1. Клонировать и установить

```bash
git clone <repo>
cd oplati_podpicky
pnpm install
```

### 2. Создать dev Supabase project

1. Supabase Dashboard → New project → **EU Central (Frankfurt)**
2. Скопировать строки подключения и ключи (см. [supabase-setup.md](supabase-setup.md))

### 3. Заполнить env

```bash
cp .env.example apps/web/.env.local
```

Заполнить по [env-vars.md](env-vars.md). Минимум для старта Sprint 1:
- `DATABASE_URL`, `DATABASE_URL_DIRECT`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN` (dev-бот!)
- `TELEGRAM_WEBHOOK_SECRET` (случайная строка)
- `ANTHROPIC_API_KEY`
- `APP_URL` (будет tunnel URL)

### 4. Применить миграции

```bash
pnpm --filter @oplati/db db:generate   # первый раз — сгенерировать миграцию из schema
pnpm --filter @oplati/db db:push       # применить к Supabase
```

Проверить в Supabase Dashboard → Table Editor — таблицы должны появиться.

### 5. Создать Storage buckets и RLS

Через Supabase SQL Editor выполнить политики из `docs/supabase-setup.md` + создать buckets:
- `payment-proofs` (private)
- `fulfillment-proofs` (private)
- `kyc-documents` (private)

### 6. Запустить tunnel

```bash
ngrok http 3000
# → https://xxx-xx-xx.ngrok.io
```

Обновить `APP_URL` в `.env.local` на tunnel URL.

### 7. Зарегистрировать Telegram webhook

```bash
DEV_URL="https://xxx-xx-xx.ngrok.io"
curl -F "url=${DEV_URL}/api/bot" \
     -F "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
     -F "drop_pending_updates=true" \
     "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook"
```

Проверка:
```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

### 8. Запустить dev-сервер

```bash
pnpm dev
```

Next.js запустится на `http://localhost:3000`, tunnel проксирует на него.

### 9. Тест

- Написать боту в Telegram → должен ответить
- Открыть `http://localhost:3000/chat` → веб-чат (когда появится в Sprint 3)
- Проверить Supabase Table Editor → `users`, `conversations`, `messages` — должны появиться записи

## Типовые команды

```bash
# Все пакеты в watch
pnpm dev

# Только web
pnpm --filter web dev

# Typecheck везде
pnpm typecheck

# Lint
pnpm lint

# Тесты
pnpm test

# Миграции
pnpm --filter @oplati/db db:generate    # после правки schema.ts
pnpm --filter @oplati/db db:push        # применить
pnpm --filter @oplati/db db:studio      # визуальный редактор

# Trigger.dev dev-режим (Sprint 3)
pnpm dlx trigger.dev@latest dev
```

## Решение типовых проблем

### `pnpm install` падает на postinstall

Проверь Node.js версию — нужна 24.

### Telegram не вызывает webhook

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

Смотри `last_error_message` и `pending_update_count`. Частые причины:
- Tunnel URL изменился — перерегистрировать webhook
- Dev-сервер не запущен
- Secret token не совпадает

### Supabase миграции не применяются

Проверь `DATABASE_URL_DIRECT` — это порт **5432**, не 6543. Pooler не поддерживает DDL.

### Anthropic 401

Проверь `ANTHROPIC_API_KEY` и биллинг в console.anthropic.com.

### `prepare: false` ошибка в postgres-js

Убедись, что в клиентском коде `@oplati/db` используется `{ prepare: false }` для Supabase pooler.

## Редактор

### VS Code

Рекомендуемые расширения (`.vscode/extensions.json`):
- `dbaeumer.vscode-eslint`
- `esbenp.prettier-vscode`
- `bradlc.vscode-tailwindcss`
- `ms-azuretools.vscode-docker` (опц.)

### Cursor / Claude Code

Особо актуально — AI-агенты будут писать код. Рекомендации:
- Начинать с чтения соответствующего `docs/*.md` перед имплементацией
- Использовать имеющиеся Zod схемы в `@oplati/types`
- Не создавать дублирующие типы
- При неясности — остановиться и задать вопрос владельцу

## Git hooks (опционально)

Sprint 2+: установить [Husky](https://typicode.github.io/husky):
- `pre-commit`: lint-staged + typecheck
- `commit-msg`: проверка Conventional Commits format

## Что НЕ делать локально

- Не использовать prod Supabase project для разработки
- Не использовать prod Telegram бот
- Не использовать prod YooKassa — всегда test shop
- Не коммитить `.env.local`
- Не запускать `db:push --force` на prod
