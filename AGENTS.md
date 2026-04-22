# AGENTS.md

> Карта проекта для AI-агентов. Обновляйте при значительных изменениях структуры.

## Project Overview

Telegram-бот + веб-чат для продажи иностранных подписок русскоязычным пользователям. Оплата в RUB/крипте, исполнение — ручное командой операторов 24/7, диалог ведёт AI-агент (Claude) с эскалацией оператору через Telegram forum-topics.

Полное описание → [`.ai-factory/DESCRIPTION.md`](.ai-factory/DESCRIPTION.md).

## Tech Stack

- **Language:** TypeScript 5.6 · Node.js 24 LTS
- **Монорепа:** pnpm + Turborepo
- **Framework:** Next.js 16 (App Router)
- **Telegram:** grammY (webhook)
- **AI:** `@anthropic-ai/sdk` (Claude Opus 4.6) · Vercel AI SDK v6 (`useChat`, стриминг)
- **Database:** Supabase Postgres 17 + Storage + Auth + Realtime
- **ORM:** Drizzle + drizzle-kit + postgres-js
- **Background jobs:** Trigger.dev 3
- **Validation:** Zod (источник правды для контрактов)
- **UI:** shadcn/ui + Tailwind
- **Observability:** Sentry + Vercel Observability
- **Rate limit:** Upstash Ratelimit
- **Deploy:** Vercel (`fra1`)

Полный стек с версиями и обоснованиями → [`docs/tech-stack.md`](docs/tech-stack.md).

## Project Structure

```
oplati_podpicky/
├── apps/
│   └── web/                         Next.js 16 — ЕЩЁ НЕ СОЗДАН (будет единым деплоем: бот, веб-чат, админка, API)
├── packages/
│   ├── agent/                       AI-агент, промпты, Tool-схемы; НЕ импортирует db
│   │   ├── package.json
│   │   ├── src/                     (каркас)
│   │   └── tsconfig.json
│   ├── db/                          Drizzle schema + repositories + migrations
│   │   ├── drizzle.config.ts
│   │   ├── package.json
│   │   ├── src/                     (каркас)
│   │   └── tsconfig.json
│   └── types/                       Zod-схемы — единый источник правды для фронт/бэк/webhook
│       ├── package.json
│       ├── src/                     (каркас)
│       └── tsconfig.json
├── docs/                            Полная спецификация проекта (24 файла)
├── .ai-factory/                     AI Factory контекст (DESCRIPTION, ARCHITECTURE)
├── .claude/skills/                  Установленные aif-* скиллы
├── .mcp.json                        MCP серверы (github, filesystem, chromeDevtools, playwright, supabase)
├── .env.example                     Шаблон ENV (Supabase, Telegram, Anthropic, YooKassa, CryptoBot, Sentry)
├── package.json                     Корневой, с turbo scripts
├── pnpm-workspace.yaml              workspaces: apps/*, packages/*
├── turbo.json                       build / dev / typecheck / lint
├── tsconfig.base.json               Общие TS-опции
├── AGENTS.md                        ← этот файл
└── README.md
```

**Статус:** каркасы пакетов созданы, `apps/web` ещё не инициализирован (`pnpm dlx create-next-app@latest apps/web ...` согласно README).

## Границы пакетов

| Пакет | Может импортировать | Запрещено |
|---|---|---|
| `@oplati/types` | только `zod` | `@oplati/*` |
| `@oplati/db` | `@oplati/types` | `@oplati/agent`, `apps/web` |
| `@oplati/agent` | `@oplati/types` | `@oplati/db` напрямую (через `ToolHandlers`) |
| `apps/web` | все `@oplati/*` | — |

Обоснование и правила именования → [`docs/repo-structure.md`](docs/repo-structure.md).

## Key Entry Points

| File | Purpose |
|------|---------|
| `apps/web/app/api/bot/route.ts` | Telegram webhook (grammY) — **будет создан** |
| `apps/web/app/api/chat/route.ts` | AI streaming для веб-чата — **будет создан** |
| `apps/web/app/api/payments/yookassa/route.ts` | YooKassa webhook — **будет создан** |
| `apps/web/app/api/payments/cryptobot/route.ts` | CryptoBot webhook — **будет создан** |
| `apps/web/app/api/trigger/[...trigger]/route.ts` | Trigger.dev ingest — **будет создан** |
| `packages/db/src/schema/*.ts` | Drizzle схема БД |
| `packages/db/drizzle.config.ts` | drizzle-kit конфиг (generate/push) |
| `packages/agent/src/index.ts` | AI-агент, промпты, ToolHandlers-интерфейс |
| `packages/types/src/index.ts` | Zod-схемы (источник правды) |
| `.env.example` | Шаблон всех ENV-переменных |

## Documentation

| Документ | Путь | Описание |
|---|---|---|
| README | [`README.md`](README.md) | Лендинг репозитория, быстрый старт |
| PRD | [`docs/PRD.md`](docs/PRD.md) | Продуктовые требования, метрики, роли |
| Architecture | [`docs/architecture.md`](docs/architecture.md) | Стек, модульный монолит, потоки, state machine, handoff |
| Tech stack | [`docs/tech-stack.md`](docs/tech-stack.md) | Версии + обоснования + запрещённые технологии |
| Repo structure | [`docs/repo-structure.md`](docs/repo-structure.md) | Монорепа, границы пакетов, именование |
| Database | [`docs/database.md`](docs/database.md) | Схема БД, индексы, RLS, инварианты |
| State machine | [`docs/state-machine.md`](docs/state-machine.md) | Жизненный цикл заказа |
| AI agent | [`docs/ai-agent.md`](docs/ai-agent.md) | Поведение AI, системный промпт, tools |
| API | [`docs/api.md`](docs/api.md) | HTTP endpoints |
| Telegram | [`docs/telegram-integration.md`](docs/telegram-integration.md) | Бот, webhook, команды, handoff |
| Web chat | [`docs/web-chat.md`](docs/web-chat.md) | Веб-чат, идентификация, anti-abuse |
| Payments | [`docs/payments.md`](docs/payments.md) | YooKassa, CryptoBot, идемпотентность |
| Supabase setup | [`docs/supabase-setup.md`](docs/supabase-setup.md) | Создание проекта, Storage, Auth, RLS |
| Background jobs | [`docs/background-jobs.md`](docs/background-jobs.md) | Trigger.dev задачи |
| Security | [`docs/security.md`](docs/security.md) | Threat model, secrets, HMAC |
| Observability | [`docs/observability.md`](docs/observability.md) | Sentry, логи, алерты |
| Coding standards | [`docs/coding-standards.md`](docs/coding-standards.md) | Конвенции кода |
| Env vars | [`docs/env-vars.md`](docs/env-vars.md) | Все переменные окружения |
| Deployment | [`docs/deployment.md`](docs/deployment.md) | Vercel, домены, регионы |
| Operator runbook | [`docs/operator-runbook.md`](docs/operator-runbook.md) | Playbook для операторов/супервизоров |
| Dev setup | [`docs/dev-setup.md`](docs/dev-setup.md) | Локальная настройка |
| Glossary | [`docs/glossary.md`](docs/glossary.md) | Термины |
| Roadmap | [`docs/roadmap.md`](docs/roadmap.md) | 3 спринта с Definition of Done |

## AI Context Files

| File | Purpose |
|---|---|
| `AGENTS.md` | Этот файл — карта проекта |
| `.ai-factory/DESCRIPTION.md` | Тонкий указатель, отсылающий к `docs/` |
| `.ai-factory/ARCHITECTURE.md` | Тонкий указатель, отсылающий к `docs/architecture.md` |
| `.ai-factory.json` | Список установленных aif-скиллов и MCP |
| `.mcp.json` | Конфигурация MCP-серверов |
| `docs/` | **Канонический источник правды** для всей реализации |

## Правило источника правды

При конфликте между кодом и `docs/` — правду диктует `docs/`; код приводится в соответствие. Исключение — если расхождение зафиксировано в ADR позже даты документа ([`docs/README.md`](docs/README.md), раздел «Источник правды»).

## Основные команды

```bash
pnpm dev                              # все пакеты в watch
pnpm build                            # production build
pnpm typecheck                        # tsc --noEmit во всех пакетах
pnpm lint                             # eslint
pnpm --filter @oplati/db db:generate  # сгенерировать миграцию из schema.ts
pnpm --filter @oplati/db db:push      # применить миграции
pnpm --filter @oplati/db db:studio    # Drizzle Studio
pnpm --filter web dev                 # только Next.js
```
