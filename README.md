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

# 2. Заполнить env
cp .env.example .env.local

# 3. Создать Next.js app (apps/web ещё пустой — см. секцию ниже)
pnpm dlx create-next-app@latest apps/web --ts --app --tailwind --eslint --src-dir=false --import-alias="@/*" --use-pnpm

# 4. Применить миграции к Supabase
pnpm --filter @oplati/db db:push

# 5. Dev
pnpm dev
```

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
