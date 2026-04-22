# Architecture

> **Канонический источник правды — [`docs/architecture.md`](../docs/architecture.md).**
> Этот файл — тонкий указатель. Любые правила границ, схема данных, state machine, handoff, очереди и безопасность — **только в `docs/`**. Дублировать здесь запрещено.

## Паттерн

**Modular monolith** на Turborepo + pnpm workspaces. Один Next.js-деплой на Vercel (fra1) + библиотечные пакеты.

Обоснование выбора (solo-dev, отсутствие организационной проблемы, distributed tx дорогой) — [docs/tech-stack.md](../docs/tech-stack.md), раздел «Рассмотренные альтернативы».

## Границы пакетов

| Пакет | Может импортировать | Запрещено |
|---|---|---|
| `@oplati/types` | только `zod` | `@oplati/*` |
| `@oplati/db` | `@oplati/types` | `@oplati/agent`, `apps/web` |
| `@oplati/agent` | `@oplati/types` | `@oplati/db` напрямую (через `ToolHandlers`) |
| `@oplati/ui` | `@oplati/types` | `@oplati/db`, `@oplati/agent` |
| `apps/web` | все `@oplati/*` | — |

Полное обоснование границ и правила именования → [docs/repo-structure.md](../docs/repo-structure.md).

## Поток данных

```
TG / Web → /api/{bot,chat} → agent.run() → Anthropic
                                  ↓
                              Supabase (Postgres + Realtime + Storage)
                                  ↓
                              Trigger.dev jobs → операторы (TG forum-topic)
```

Полная схема с payments, handoff, очередями → [docs/architecture.md](../docs/architecture.md).

## State Machine заказа

`draft → clarifying → ready_for_payment → pending_payment → paid → in_fulfillment → completed` с ветками `kyc_required`, `expired`, `cancelled`, `failed`, `refund_requested`, `refunded`.

Все переходы — атомарные транзакции с записью в `order_events` (append-only). Диаграмма и инварианты → [docs/state-machine.md](../docs/state-machine.md).

## Архитектурные инварианты

1. `order_events` append-only — никогда не update/delete.
2. Идемпотентность webhook: `(provider, provider_ref)` unique.
3. Деньги в копейках (`integer`), не `numeric`/`float`.
4. `agent` общается с БД только через `ToolHandlers` (интерфейс определён в `@oplati/agent`, реализация в `apps/web/lib/tool-handlers/`).
5. Zod-схемы в `@oplati/types` — **единственный** источник правды для границ API, webhook, DB.

Детали и примеры → [docs/architecture.md](../docs/architecture.md), [docs/coding-standards.md](../docs/coding-standards.md).
