# Технологический стек

## Обязательные технологии (источник правды)

| Слой | Технология | Версия | Почему |
|---|---|---|---|
| Язык | TypeScript | 5.6+ | Статическая типизация, единый стек фронт+бэк+бот |
| Runtime | Node.js | 24 LTS | Default на Vercel Fluid Compute |
| Менеджер пакетов | pnpm | 9.12+ | workspace hoisting, быстрее npm/yarn |
| Монорепа | Turborepo | 2.3+ | инкрементальные билды, кэш, простая конфигурация |
| Фреймворк | Next.js | 16.x (App Router) | Единый app для бота, веб-чата, админки, API |
| Telegram-бот | grammY | 1.30+ | Современный, TS-first, webhook-friendly |
| AI SDK (стриминг веб-чат) | Vercel AI SDK | 6.x | `useChat`, стриминг, unified tool-calling |
| Anthropic | `@anthropic-ai/sdk` | 0.32+ | Прямой SDK для tool-use в Telegram-боте |
| Модель | Claude Opus 4.6 | — | Качество диалога на русском, сильный tool-calling |
| БД | Supabase Postgres | 17 | ACID + Storage + Auth + Realtime единым пакетом |
| ORM | Drizzle ORM | 0.36+ | SQL-first, лёгкий, хорошая DX |
| Миграции | drizzle-kit | 0.28+ | `generate` / `push` из schema.ts |
| Драйвер | postgres-js | 3.4+ | Совместим с Supabase pooler (`prepare: false`) |
| Очереди/cron | Trigger.dev | 3.x | TS-native, durable, schedules + events |
| Валидация | Zod | 3.23+ | Zod-схемы — источник правды для типов фронт+бэк |
| UI | shadcn/ui + Tailwind | — | Для админки и веб-чата (2–3 спринты) |
| Мониторинг | Sentry | — | `@sentry/nextjs`, PII-scrubbing обязателен |
| Rate limit | Upstash Ratelimit | — | Serverless-совместимый, бесплатный tier |
| Деплой | Vercel | — | Регион `fra1`, Fluid Compute |
| Версионирование | git + GitHub | — | Conventional commits |

## Запрещено без явного согласования владельца

- **Prisma** (вместо Drizzle) — отличается подход к миграциям и runtime overhead
- **Express/Fastify** рядом с Next.js — API routes внутри Next.js достаточно
- **Redux/MobX** — локальное состояние React + Supabase Realtime, больше не нужно
- **JSON-поля для критичной структуры** — использовать колонки и связи, `jsonb` только для действительно гибких/редко-читаемых данных
- **REST без Zod-валидации на границах** — любой входящий JSON парсится через Zod
- **Python-воркеры** — только если владелец явно попросит (ML/OCR-задачи)

## Рассмотренные альтернативы и почему отклонены

| Альтернатива | Отклонено, потому что |
|---|---|
| Python + aiogram | Появился веб-чат → React обязателен → два стека дороже |
| Микросервисы | Solo-dev; организационной проблемы нет; distributed tx дороже модульности |
| Neon вместо Supabase | Нужны Storage + Realtime + Auth — в Supabase в одном пакете |
| Prisma вместо Drizzle | Overhead query engine, хуже serverless cold-start |
| Railway вместо Vercel | После перехода на TS и Next.js Vercel стал очевидным выбором |
| Vercel AI Gateway | Владелец выбрал прямой Anthropic SDK — меньше слоёв, проще дебаг |
| Celery/RQ | Это Python; на TS аналог — Trigger.dev |
| tRPC | Избыточно для этого проекта — Zod + RSC actions достаточно |

## Версии обновлять сознательно

Major-апдейты Next.js, Node.js, Supabase — только с миграционным планом и тестом preview-деплоя. Не обновлять автоматически.
