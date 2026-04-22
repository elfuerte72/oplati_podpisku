# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Источник правды

**При любом конфликте «код ↔ `docs/`» побеждает `docs/`.** Это не обычный репо — здесь сначала пишется спецификация в `docs/`, а код приводится в соответствие. Исключения фиксируются новым ADR, датированным позже документа (см. `docs/README.md`).

- Карта проекта для агентов: [`AGENTS.md`](AGENTS.md) (структура, границы, entry points).
- Полная спецификация: [`docs/`](docs/) — 23 файла, навигация в [`docs/README.md`](docs/README.md).
- Roadmap и Definition of Done: [`docs/roadmap.md`](docs/roadmap.md) + зеркало милстоунов в [`.ai-factory/ROADMAP.md`](.ai-factory/ROADMAP.md).

Перед имплементацией тикета — прочитайте соответствующий файл из `docs/`. Если поведение не описано, **не додумывайте** — остановитесь и спросите владельца (см. `docs/coding-standards.md`, «Сначала спецификация, потом код»).

## Workflow через ai-factory

В репо установлен [ai-factory](https://github.com/lee-to/ai-factory): `.claude/skills/aif-*` (22 скилла) + конфиг в `.ai-factory.json`. Предпочитайте эти команды для крупной работы:

- `/aif-plan <описание>` — план тикета (создаёт feature-ветку + план-файл).
- `/aif-implement` — исполнение существующего плана по шагам.
- `/aif-review` — code review перед коммитом.
- `/aif-verify` — финальная сверка с DoD.
- `/aif-fix` / `/aif-improve` / `/aif-explore` / `/aif-docs` / `/aif-ci` — по назначению.

Скиллы читают `.ai-factory/skill-context/<skill>/SKILL.md` как project-level override — если он существует, его правила побеждают встроенные.

## Команды

Монорепа pnpm + Turborepo. Все команды из корня:

```bash
pnpm install                            # установка (один раз)
pnpm dev                                # все пакеты в watch
pnpm build                              # production build
pnpm typecheck                          # tsc --noEmit во всех workspace
pnpm lint                               # eslint
pnpm --filter web dev                   # только Next.js (когда apps/web создан)
pnpm --filter @oplati/db db:generate    # сгенерировать миграцию из schema.ts
pnpm --filter @oplati/db db:push        # применить миграции к Supabase
pnpm --filter @oplati/db db:studio      # Drizzle Studio
pnpm --filter <pkg> test -- <pattern>   # один тест (Vitest, появится со Sprint 2)
```

### Миграции БД

**Forward-only через Drizzle.** Схема — в `packages/db/src/schema.ts`. Правка схемы → `db:generate` создаёт `.sql` в `packages/db/drizzle/` → `db:push` применяет. Никогда не редактировать уже применённую миграцию и не править БД кликами в Supabase Dashboard в обход Drizzle. Destructive-миграции — только backwards-compatible (nullable-колонки, два деплоя для удаления), иначе rollback кода оставит БД в несовместимом состоянии.

### Статус репо

`apps/web` **ещё не инициализирован** — первая команда по [`README.md`](README.md#быстрый-старт):

```bash
pnpm dlx create-next-app@latest apps/web --ts --app --tailwind --eslint --src-dir=false --import-alias="@/*" --use-pnpm
```

## Архитектура

**Modular Monolith:** один Next.js-деплой на Vercel (`fra1`) + три библиотечных пакета. Подробный flow — в [`docs/architecture.md`](docs/architecture.md).

### Границы пакетов (строго!)

| Пакет | Может импортировать | Запрещено |
|---|---|---|
| `@oplati/types` | только `zod` | `@oplati/*` |
| `@oplati/db` | `@oplati/types` | `@oplati/agent`, `apps/web` |
| `@oplati/agent` | `@oplati/types` | **`@oplati/db` напрямую** (через `ToolHandlers`) |
| `apps/web` | все `@oplati/*` | — |

`@oplati/agent` общается с БД только через интерфейс `ToolHandlers` (реализация в `apps/web/lib/tool-handlers/`). Это позволяет мокать tools в тестах и вынести агента в отдельный сервис без переписывания. Не ломайте границу «потому что так быстрее».

Импорты — только через barrel (`@oplati/db`, не `@oplati/db/src/schema`). `../../../` cross-package imports запрещены.

### Архитектурные инварианты (не нарушать)

1. **`order_events` — append-only.** Никогда не `UPDATE`/`DELETE`. Любое изменение статуса = новая строка в той же транзакции, что меняет `orders.status`. RLS в Supabase это ещё и форсит.
2. **Идемпотентность webhook'ов** — `UNIQUE(provider, provider_ref)` на `payments` + `INSERT ... ON CONFLICT DO NOTHING`. Повторный вызов не должен создавать дубль или двойной переход.
3. **Деньги — в копейках (`integer`).** Никогда `numeric`/`float` для сумм. `amount_rub` хранит копейки; `original_amount` — минимальные единицы валюты.
4. **State-переходы заказа — только через `transitionOrder()`.** Прямой `UPDATE orders SET status = ...` в коде запрещён. Разрешённые переходы — в таблице `allowedTransitions` (`packages/types`). Полный state machine: [`docs/state-machine.md`](docs/state-machine.md).
5. **Zod на всех границах.** Webhook body, Telegram updates, AI tool inputs, URL params — парсятся схемой из `@oplati/types`. Не `any`, не `as T` без обоснования.
6. **Webhook endpoints всегда `200 OK`** (даже при невалидном input — ошибка в теле), иначе Telegram/YooKassa будут ретраить и забьют очередь.

### Потоки

- **Telegram → `/api/bot`** (grammY, проверка `X-Telegram-Bot-Api-Secret-Token`) → `agent.run()` → Anthropic → tools (`search_catalog`, `propose_order`, `confirm_order`, `request_human`) → Supabase.
- **Web chat → `/api/chat`** (Vercel AI SDK, SSE-стриминг, Upstash Ratelimit) → тот же `agent.run()`.
- **Handoff оператору** — через Telegram **forum-topics**: один topic = один заказ, бот-посредник между user и operator, `/ai_back` возвращает диалог AI. Детали: [`docs/telegram-integration.md`](docs/telegram-integration.md).
- **Payments** — YooKassa (RUB/СБП) + CryptoBot (USDT) через HMAC-подписанные webhook'и. Детали: [`docs/payments.md`](docs/payments.md).
- **Фоновые задачи (Trigger.dev v3)** — `poll-payment` (подстраховка от потерянных webhook'ов), `expire-payments`, `alert-slow-fulfillment`, `handoff-request`, `fulfillment-complete`.

## Конвенции кода

Полные правила в [`docs/coding-standards.md`](docs/coding-standards.md). Ключевое:

- **`strict: true`** + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`. `any` запрещён; `unknown` + Zod narrow.
- **Never swallow errors** — `catch {}` и `catch { console.log }` запрещены. Всегда либо re-throw, либо `Sentry.captureException` + structured error.
- **Result pattern** для ожидаемых неудач (`{ ok: false, reason }`); `throw` — только для неожиданного.
- **`console.log` запрещён** в production-коде — только `logger.*`.
- **`fetch` без timeout запрещён** — всегда `AbortController`.
- **Конвенции именования:** `camelCase` функции, `PascalCase` типы/классы, `UPPER_SNAKE_CASE` только для compile-time констант, `snake_case` для БД, `kebab-case.ts` файлы, `PascalCase.tsx` React-компоненты.
- **Commits — Conventional Commits** (`feat(agent):`, `fix(payments):`); squash merge на PR; заголовок ≤ 72 символа.
- **RSC по умолчанию**, `"use client"` — только где нужен браузерный API.

## MCP-серверы

`.mcp.json`: `github`, `filesystem`, `chromeDevtools`, `playwright`, `supabase` (HTTP MCP с зашитым `project_ref=nyxijwpuvctmvemaemqn` — при первом использовании потребует OAuth). Через Supabase MCP можно `execute_sql` / `apply_migration` / `list_tables` и т.п. — но помните golden rule: применённые миграции через Drizzle, а не через dashboard.

## Что запрещено

- Кросс-импорты между `apps/*`, циклы между пакетами, импорт приватных путей пакетов.
- `pnpm --filter @oplati/db db:push --force` на prod.
- Commit `.env.local` / `.env` / реальных токенов (`.gitignore` это покрывает — не отключайте).
- Использовать prod Supabase / Telegram-бот / YooKassa shop для локальной разработки.
- Эмодзи в коде, комментариях, логах (в UI-строках на русском — можно, если требует продукт).
- Создавать код до того, как прочитан соответствующий файл из `docs/`.
