# Архитектура и устройство кодовой базы

> Справочный документ. Правила разработки и инварианты — в [`CLAUDE.md`](../CLAUDE.md) (источник правды — код + CLAUDE.md). Как работает база данных — [`database.html`](database.html). История изменений — [`CHANGELOG.md`](CHANGELOG.md).

## Что это за продукт

«Оплати подписку» — сервис оплаты иностранных подписок для русскоязычных пользователей. Клиент пишет в Telegram-бот или веб-чат, что хочет оплатить (Netflix, ChatGPT Plus, любой другой сервис), — AI-агент «Оплатишка» находит актуальную цену, создаёт заказ с комиссией 10%, выставляет счёт в RUB через Love&Pay. После оплаты исполнение пока ручное (оператор), в разработке — автоматическая выдача виртуальных USD-карт через PaySpace.

## Архитектурный паттерн: Modular Monolith

Один деплой (Next.js на Vercel, регион `fra1`) + три библиотечных пакета в монорепе. Никаких микросервисов: масштаб (~50 заказов/день) не оправдывает распределённость, а границы между модулями обеспечиваются правилами импортов, а не сетью.

```
┌─────────────────────────────────────────────────────────┐
│  apps/web (Next.js 16, Vercel fra1)                     │
│                                                         │
│  Telegram ──→ /api/bot ──┐                              │
│  Браузер  ──→ /api/chat ─┤──→ runAgent() ──→ Anthropic  │
│                          │        │                     │
│                          │     tools (5)                │
│                          │        │                     │
│                          │   ToolHandlers ──→ Supabase  │
│                          │                              │
│  Love&Pay ──→ /api/payments/loveandpay (webhook)        │
│  Vercel Cron ──→ /api/cron/* (5 джобов)                 │
└─────────────────────────────────────────────────────────┘
         │                    │                  │
   @oplati/agent         @oplati/db        @oplati/types
   (AI, промпты,      (Drizzle schema,    (Zod-схемы,
    tool-схемы)        repositories)      state machine)
```

## Файловая система: кто за что отвечает

### Корень монорепы

| Путь | Назначение |
|---|---|
| `package.json` | корневые скрипты (`dev`/`build`/`typecheck`/`lint` через Turborepo) |
| `pnpm-workspace.yaml` | workspaces: `apps/*`, `packages/*` |
| `turbo.json` | конфигурация задач Turborepo |
| `tsconfig.base.json` | общие строгие TS-опции (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) |
| `apps/web/vercel.json` | расписание Vercel Cron |
| `.mcp.json` | MCP-серверы для AI-инструментов |
| `CLAUDE.md` | правила разработки, инварианты, деплой, секреты |

### `packages/types` — контракты

Единственная зависимость — `zod`. Здесь живут Zod-схемы всех границ (webhook-тела Love&Pay, гипотеза контракта PaySpace, Telegram-типы) и **state machine заказа** (`order-state-machine.ts`): таблица `allowedTransitions` + `OrderTransitionError`. И фронт, и бэк, и БД-слой выводят типы отсюда — поэтому пакет не имеет права импортировать ничего из `@oplati/*`.

### `packages/db` — данные

Drizzle ORM поверх Supabase Postgres (подключение через pooler, `prepare: false`).

- `src/schema.ts` — вся схема: 10 таблиц + enum'ы. RLS включён везде, кроме публичного каталога `services`.
- `src/repositories/` — единственный санкционированный способ работы с данными: `users` (upsert по telegram_id), `conversations`, `messages` (append-only), `services`, `orders` (**`transitionOrder()`** — единственная точка смены статуса заказа: валидирует переход по `allowedTransitions`, пишет `order_events` в той же транзакции), `payments` (идемпотентный insert), `cards`, `health` (`pingDb`).
- `drizzle/` — forward-only миграции; `scripts/seed-catalog.ts` — идемпотентный seed каталога.
- `repositories/logger.ts` — интерфейс `RepoLogger` (pino-shape), чтобы пакет не зависел от pino.

### `packages/agent` — AI

Не импортирует `@oplati/db` — с миром общается через интерфейс `ToolHandlers`, реализацию которого инжектит `apps/web`. Это позволяет мокать tools в тестах и при необходимости вынести агента в отдельный сервис.

- `src/index.ts` — `runAgent()` (полный tool-loop на `@anthropic-ai/sdk`: модель → tool_use → handler → tool_result → ... до финального текста) и `runAgentNoTools()` (деградация без БД). Модель — `claude-sonnet-4-6`, override через `ANTHROPIC_MODEL`.
- `src/prompts.ts` — системный промпт Оплатишки, `GREETING`.
- `src/tools.ts` — JSON-схемы 5 tools: `web_search` (серверный tool Anthropic — актуальные цены), `search_catalog`, `propose_order`, `confirm_order`, `request_human`.

### `apps/web` — всё остальное

```
app/
  page.tsx                        веб-чат (главная страница)
  styleguide/                     витрина UI-компонентов
  api/
    bot/route.ts                  Telegram webhook
    chat/route.ts + history/ + clear/   веб-чат API
    payments/create/              создание инвойса L&P (internal, X-Internal-Token)
    payments/loveandpay/          webhook L&P
    orders/confirm/ + status/     подтверждение и статус заказа
    cron/                         5 cron-эндпоинтов (авторизация CRON_SECRET)
    admin/telegram-webhook/       управление webhook бота без раскрытия токена
    health/route.ts               liveness
components/
  chat/                           компоненты чата (сообщения, инпут, панель заказа)
  comic/                          комикс-примитивы (halftone, маскот, штамп «ОПЛАЧЕНО»)
lib/
  env.ts / env.server.ts          Zod-валидация env, lazy; server-only re-export
  logger.ts                       pino + redact PII + childLogger(module)
  sentry.ts                       beforeSend PII-scrubber
  supabase/                       browser / server / admin клиенты
  telegram/                       grammY bot singleton, handle-update (диспатч), templates
  tool-handlers/                  реализация ToolHandlers (мост agent → db)
  loveandpay/                     клиент, HMAC-подпись, webhook-handlers (+ Vitest)
  pay-space/                      клиент PaySpace (createCard/topupCard/getCard) — фаза 2
  jobs/                           логика cron-джобов + dispatcher
  chat/                           cookie-сессия и история веб-чата
instrumentation.ts                Sentry server/edge + fail-fast env
```

## Как это работает: основные сценарии

### 1. Диалог (Telegram и веб — один агент)

1. Запрос приходит в `/api/bot` (проверка `X-Telegram-Bot-Api-Secret-Token`; единственный non-200 кейс → `401`) или `/api/chat` (cookie-сессия).
2. Upsert пользователя и активного диалога, append входящего сообщения (`@oplati/db`).
3. Загружается недавняя история → `runAgent(history, toolHandlers)`.
4. Агент крутит tool-loop: ищет цену через `web_search`, сверяется с каталогом, создаёт черновик заказа (`propose_order` — расчёт RUB-суммы: USD-центы × курс USDT→RUB × 1.10), после согласия клиента — `confirm_order`.
5. Ответ агента append'ится в БД и уходит клиенту (в Telegram — с разбивкой по 4096 символов).
6. **Graceful degradation:** если БД недоступна — `runAgentNoTools` (бот отвечает, но без памяти и заказов); если Anthropic недоступен — понятный текст с предложением позвать оператора.

### 2. Оплата (Love&Pay)

1. `confirm_order` → внутренний `POST /api/payments/create` (защита `X-Internal-Token`, self-call в свой же deployment) → инвойс L&P → ссылка клиенту.
2. Заказ: `ready_for_payment → pending_payment` через `transitionOrder()`.
3. Клиент платит → L&P шлёт webhook `invoice.paid` на `/api/payments/loveandpay`: проверка подписи, Zod-парс, идемпотентность по `UNIQUE(provider, provider_ref)` → `pending_payment → paid` + событие в `order_events` + Telegram-уведомление клиенту. Webhook всегда отвечает `200` (ошибки — в теле), чтобы L&P не ретраил бесконечно.
4. Подстраховка: cron `poll-payment` каждые 5 минут опрашивает зависшие `pending_payment` (потерянные webhook'и), `expire-payments` закрывает просроченные.

### 3. Жизненный цикл заказа (state machine)

13 статусов, переходы — только через `transitionOrder()`:

```
draft → clarifying → kyc_required ⇄ clarifying
      ↘ ready_for_payment → pending_payment → paid → in_fulfillment → completed
                                  ↘ expired      ↘ failed                ↘ refund_requested → refunded
```

Терминальные (`failed`, `cancelled`, `refunded`, `expired`) — без выходов: заказ не переоткрывается, заводится новый. Каждый переход = строка в append-only `order_events` в той же транзакции.

### 4. Фоновые задачи (Vercel Cron)

`vercel.json` → `GET /api/cron/<job>` (авторизация по `CRON_SECRET`) → `lib/jobs/<job>.ts`. Работают **только на production-деплое**.

| Job | Расписание | Что делает |
|---|---|---|
| `poll-payment` | каждые 5 мин | сверка зависших платежей с L&P |
| `expire-payments` | каждые 15 мин | `pending_payment → expired` по таймауту |
| `renewal-reminder` | 07:00 UTC | напоминания о продлении подписки |
| `recycle-cards` | 03:30 UTC | карты: 90 дней простоя → `idle`, 180 → `recycled` |
| `keepalive` | каждые 6 ч | `SELECT 1` — анти-автопауза Supabase free tier |

### 5. Эскалация оператору (частично)

`request_human` пишет `handoff_requested` в `order_events` (дедуп 5 минут, защита от чужого orderId) и говорит клиенту SLA в зависимости от рабочих часов. Целевая схема — Telegram forum-topics (topic = заказ, `/ai_back` возвращает AI) — **не реализована**.

### 6. Виртуальные карты PaySpace (фаза 2, выпуск выключен)

После `paid` job `issue-card` должен выдать клиенту реквизиты USD-карты: topup активной карты → переиспользование recycled → выпуск новой через PaySpace, затем `paid → in_fulfillment → completed` (actor `system`). Сейчас без `PAYSPACE_API_KEY` + `PAYSPACE_ACCOUNT_ID` срабатывает guard `skipped_no_paypace` — заказ остаётся в `paid` для ручного исполнения. Блокеры: контракт PaySpace не подтверждён живым вызовом; не решён триггер заморозки карты. Полные PAN/CVC никогда не попадают в БД/логи — только `pan_masked`; реквизиты клиенту уходят единственным путём — сообщением в Telegram.

## Окружения и деплой

| | Production | Preview |
|---|---|---|
| URL | `oplati-podpisku-web.vercel.app` | `oplati-podpisku-web-git-<branch>-<team>.vercel.app` |
| Telegram-бот | `@test_prodipsa_bot` | `@dev_test_podpiska_bot` |
| Триггер деплоя | merge в `main` | push в feature-ветку |

Боты раздельные, потому что webhook у бота один. Deployment Protection выключена (иначе Telegram получает `401` до нашего кода) — защита на уровне эндпоинтов: secret-token, подпись L&P, `X-Internal-Token`, RLS. Детали и карта секретов — в [`CLAUDE.md`](../CLAUDE.md).

## Наблюдаемость

- **Sentry** — все неожиданные ошибки (`captureException`), PII вычищается в `beforeSend`; критичные деградации (БД недоступна, выпуск карты упал) — отдельные алерты.
- **pino** — структурные логи через `childLogger('module')`; `console.log` запрещён; токены/PAN/CVC редактируются.
- `/api/health` — liveness; cron `keepalive` — heartbeat БД.
