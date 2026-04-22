# Оплати подписки

Telegram-бот + веб-чат для продажи иностранных подписок русскоязычным пользователям.

## Документация
- [PRD](docs/PRD.md) — продуктовые требования
- [Архитектура](docs/architecture.md) — стек, схема, потоки, state machine
- [Roadmap](docs/roadmap.md) — разбивка на 3 спринта

## Стек (TL;DR)
TypeScript · Next.js 16 · Supabase (Postgres + Storage + Auth + Realtime) · Drizzle · grammY · Vercel AI SDK v6 · Anthropic Claude · Trigger.dev · Vercel · Sentry

## Структура
```
apps/web          Next.js 16 (бот webhook, веб-чат, админка, API)
packages/agent    AI-агент + промпты + tools
packages/db       Drizzle схема + клиент + репозитории
packages/types    Zod-контракты (источник правды для фронта и бэка)
```

## Быстрый старт

```bash
# 1. Установить зависимости
pnpm install

# 2. Заполнить env приложения (apps/web уже инициализирован)
cp .env.example apps/web/.env.local
# отредактировать apps/web/.env.local — минимум SUPABASE_URL / SUPABASE_ANON_KEY /
# SUPABASE_SERVICE_ROLE_KEY / ANTHROPIC_API_KEY / APP_URL; см. docs/env-vars.md

# 3. Применить миграции к Supabase
pnpm --filter @oplati/db db:push

# 4. Dev
pnpm dev
```

> `apps/web` создан через `create-next-app` на базе Next.js 16 (App Router, Tailwind v4, TS strict). Повторно запускать `create-next-app` не нужно.

## Что сделать руками перед первым запуском

1. Создать проект на [Supabase](https://supabase.com) (EU region)
2. Создать бота через [@BotFather](https://t.me/BotFather), получить токен
3. Создать Telegram-группу операторов с включёнными форумами; добавить бота админом
4. Зарегистрировать аккаунты: Vercel, Trigger.dev, Sentry
5. Получить Anthropic API key
6. Заполнить `.env.local` по шаблону из `.env.example`

## Основные команды

| Команда | Что делает |
|---|---|
| `pnpm dev` | запуск Next.js + watch пакетов |
| `pnpm build` | production-сборка |
| `pnpm --filter @oplati/db db:generate` | сгенерировать миграцию из schema.ts |
| `pnpm --filter @oplati/db db:push` | применить к БД |
| `pnpm --filter @oplati/db db:studio` | Drizzle Studio |
| `pnpm typecheck` | проверка типов во всём монорепо |
