# Project: Оплати подписки

> **Канонический источник правды — каталог [`docs/`](../docs/).**
> Этот файл — тонкий указатель для `/aif-*` команд. При противоречии побеждает `docs/`.

## Overview

Telegram-бот + веб-чат для продажи иностранных подписок (Claude, Netflix, ChatGPT, Airbnb и т.п.) русскоязычным пользователям. Оплата рублями (YooKassa/СБП) и криптой (CryptoBot); фактическую оплату на стороне иностранного сервиса выполняет команда операторов 24/7. Один AI-агент (Claude Opus 4.6) работает в обоих каналах и эскалирует сложные случаи оператору через Telegram-группу с forum-topics.

**Целевой объём на старте:** 50 заказов/день; AI handle rate ≥ 70%; p95 time-to-fulfillment < 2 ч.

Подробнее → [docs/PRD.md](../docs/PRD.md).

## Tech Stack

TypeScript 5.6 · Node.js 24 · pnpm + Turborepo · Next.js 16 (App Router) · grammY · Vercel AI SDK v6 · `@anthropic-ai/sdk` (Claude Opus 4.6) · Supabase Postgres 17 + Storage + Auth + Realtime · Drizzle + drizzle-kit + postgres-js · Trigger.dev 3 · Zod · shadcn/ui + Tailwind · Sentry · Upstash Ratelimit · Vercel (fra1).

Полный стек с версиями и обоснованиями → [docs/tech-stack.md](../docs/tech-stack.md).

## Architecture

Modular monolith: один Next.js-деплой (`apps/web`) + три библиотечных пакета (`@oplati/agent`, `@oplati/db`, `@oplati/types`). Строгие границы: `agent` не импортирует `db` (ToolHandlers подставляются извне).

Схема данных, state machine заказа, handoff оператору, очереди → [docs/architecture.md](../docs/architecture.md), [docs/state-machine.md](../docs/state-machine.md), [docs/repo-structure.md](../docs/repo-structure.md).

## Навигация по документации

| Область | Файл |
|---|---|
| Продуктовые требования | [docs/PRD.md](../docs/PRD.md) |
| Архитектура и потоки | [docs/architecture.md](../docs/architecture.md) |
| Стек с обоснованиями | [docs/tech-stack.md](../docs/tech-stack.md) |
| Структура репо | [docs/repo-structure.md](../docs/repo-structure.md) |
| Схема БД + RLS | [docs/database.md](../docs/database.md) |
| Жизненный цикл заказа | [docs/state-machine.md](../docs/state-machine.md) |
| AI-агент, промпт, tools | [docs/ai-agent.md](../docs/ai-agent.md) |
| HTTP endpoints | [docs/api.md](../docs/api.md) |
| Telegram (бот, handoff) | [docs/telegram-integration.md](../docs/telegram-integration.md) |
| Веб-чат | [docs/web-chat.md](../docs/web-chat.md) |
| Платежи + идемпотентность | [docs/payments.md](../docs/payments.md) |
| Supabase (setup, Storage, Auth) | [docs/supabase-setup.md](../docs/supabase-setup.md) |
| Фоновые задачи (Trigger.dev) | [docs/background-jobs.md](../docs/background-jobs.md) |
| Безопасность | [docs/security.md](../docs/security.md) |
| Observability (Sentry, логи) | [docs/observability.md](../docs/observability.md) |
| Конвенции кода | [docs/coding-standards.md](../docs/coding-standards.md) |
| ENV-переменные | [docs/env-vars.md](../docs/env-vars.md) |
| Deployment (Vercel) | [docs/deployment.md](../docs/deployment.md) |
| Runbook оператора | [docs/operator-runbook.md](../docs/operator-runbook.md) |
| Dev setup | [docs/dev-setup.md](../docs/dev-setup.md) |
| Глоссарий | [docs/glossary.md](../docs/glossary.md) |
| Roadmap (3 спринта) | [docs/roadmap.md](../docs/roadmap.md) |

## Non-Functional Requirements

- **Идемпотентность** всех webhook endpoints по `(provider, provider_ref)`.
- **`order_events`** — append-only audit log; любое изменение статуса = новая строка в той же транзакции.
- **Деньги** — `amount_rub` всегда в копейках (`integer`), никогда `numeric`/`float`.
- **Secrets** — только в Vercel env, никогда в коде.
- **PII-scrubbing** в Sentry; не логировать полные тексты сообщений пользователя.
- **Rate limit** на `/api/chat` (Upstash Ratelimit) по `user+IP`.
- **Webhook endpoints** — всегда `200 OK` даже при невалидном input, ошибка — в теле.

Детали — [docs/security.md](../docs/security.md), [docs/coding-standards.md](../docs/coding-standards.md).
