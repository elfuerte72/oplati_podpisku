# Оплати подписки («Оплатишка»)

Telegram-бот + веб-чат, через которые русскоязычные пользователи оплачивают иностранные
подписки. Клиент пишет, что хочет оплатить, — AI-агент «Оплатишка» находит цену, создаёт
заказ и принимает оплату в рублях. Исполнение (выпуск виртуальной карты / оплата сервиса)
пока ручное на стороне операторов, частично автоматизировано через PaySpace. Масштаб
старта — ~50 заказов/день.

> **Контекст для Claude Code и разработчиков.** Источник правды по поведению, инвариантам
> и конвенциям — [`CLAUDE.md`](./CLAUDE.md). Этот README даёт карту репозитория и общую
> картину; при расхождении деталей верь коду и `CLAUDE.md`. Дополнительно: справочная
> документация в [`docs/`](./docs/), план фазы 2 — [`PLAN.md`](./PLAN.md).

---

## Как это работает (общая картина)

```
                 ┌──────────────────┐         ┌──────────────────┐
   Telegram ───► │  /api/bot        │         │  /api/chat       │ ◄─── Веб-чат (page.tsx)
   (grammY)      │  (webhook)       │         │  (JSON, без      │      комикс-UI
                 └────────┬─────────┘         │   стриминга)     │
                          │                   └────────┬─────────┘
                          │   один и тот же агент      │
                          ▼   (инвариант обоих каналов)▼
                 ┌─────────────────────────────────────────────┐
                 │  runAgent() — @oplati/agent                  │
                 │  Haiku-роутер → Anthropic (Sonnet) tool-loop │
                 │  tools: web_search, search_catalog,          │
                 │         propose_order, confirm_order,        │
                 │         request_human                        │
                 └───────────────────┬─────────────────────────┘
                                     │ ToolHandlers (в apps/web/lib/tool-handlers)
                                     ▼
        ┌────────────────────────────────────────────────────────────┐
        │  Supabase Postgres (Drizzle)   ·   Love&Pay (приём RUB)      │
        │                                ·   PaySpace (выпуск USD-карт)│
        └────────────────────────────────────────────────────────────┘
```

**Поток заказа (happy path):**

1. Клиент описывает желаемую подписку → агент через `web_search`/`search_catalog` находит цену.
2. `propose_order` — расчёт суммы (USD-цена × курс USDT→RUB + комиссия `COMMISSION_PERCENT`, на проде 30%), границы $1–500, ≤10 заказов/сутки.
3. `confirm_order` → внутренний `POST /api/payments/create` создаёт инвойс Love&Pay → клиент получает ссылку на оплату в рублях.
   - **Гейт:** веб-пользователь без привязанного `telegram_id` ссылку не получает (`TelegramLinkRequiredError`) — реквизиты карты доставляются только в Telegram.
4. Клиент платит → webhook `/api/payments/loveandpay` (`invoice.paid`) атомарно переводит заказ в `paid`, уведомляет клиента и запускает `issue-card`.
5. `issue-card` выпускает/пополняет виртуальную USD-карту в **PaySpace** на USD-сумму заказа **+ буфер `PAYSPACE_CARD_BUFFER_PERCENT` (20%)** под местный VAT/FX/foreign-fee (буфер только на карте, в цену клиента не входит, возвращается на VCC-баланс при release) и шлёт реквизиты клиенту в Telegram → заказ `completed`.

> **Важно:** Love&Pay (приём рублей) и PaySpace (USD-карты) — **две независимые сущности**.
> VCC-баланс PaySpace пополняется вручную из крипто-баланса (модель префандинга);
> автоматического перевода RUB → USD между ними нет.

---

## Стек

TypeScript 5.6 · Node.js 24 · pnpm + Turborepo · Next.js 16 (App Router) · grammY ·
`@anthropic-ai/sdk` (свой tool-loop, default-модель `claude-sonnet-4-6`) · Supabase Postgres
(Storage/Auth/Realtime) · Drizzle · Zod · Tailwind v4 · Sentry + pino · Vitest ·
Vercel `fra1` + Vercel Cron.

**Осознанно НЕ используем** (не предлагать без явного запроса): Vercel AI SDK и токен-стриминг,
Trigger.dev (хватает Vercel Cron), shadcn/ui (свой комикс-UI). Обоснование — в `CLAUDE.md`.

---

## Структура репозитория

Монорепо pnpm + Turborepo. Один деплой — `apps/web`; общая логика вынесена в пакеты
`@oplati/*` со строгими границами импортов.

```
oplati_podpicky/
├── CLAUDE.md                  ← источник правды: поведение, инварианты, конвенции
├── PLAN.md                    ← план фазы 2 (виртуальные карты PaySpace)
├── README.md                  ← этот файл
├── turbo.json                 ← пайплайн Turborepo (build/dev/typecheck/lint)
├── pnpm-workspace.yaml        ← состав воркспейса
├── tsconfig.base.json         ← общий strict-конфиг TS
├── docs/                      ← справочная документация (не источник правды)
│   ├── architecture.md          архитектура и устройство кодовой базы
│   ├── database.html            как работает БД
│   ├── ai-cost-protection.md    слои защиты AI-расходов
│   └── CHANGELOG.md
│
├── apps/web/                  ← Next.js 16 — единый деплой (веб-чат + API + cron + кабинет)
│   ├── vercel.json              расписание Vercel Cron (5 джобов)
│   ├── app/
│   │   ├── page.tsx             веб-чат «Оплатишка» (комикс-UI)
│   │   ├── layout.tsx
│   │   ├── cabinet/             личный кабинет пользователя
│   │   ├── payment-success/     страница после оплаты L&P
│   │   ├── styleguide/          витрина комикс-компонентов
│   │   └── api/                 ← все серверные эндпоинты (см. таблицу ниже)
│   ├── components/
│   │   ├── chat/                UI веб-чата (бабблы, карточки заказа, TelegramLink)
│   │   ├── comic/               комикс-примитивы (speech bubble, halftone, «ОПЛАЧЕНО»)
│   │   ├── intro/               IntroOverlay при первом визите
│   │   └── cabinet/             UI личного кабинета
│   └── lib/
│       ├── env.ts / env.server.ts   Zod-валидация env (lazy + server-only)
│       ├── logger.ts                pino singleton + childLogger(module)
│       ├── sentry.ts                shared Sentry options + PII beforeSend
│       ├── ratelimit.ts             per-identity rate-limit (Upstash sliding window)
│       ├── supabase/                browser / server / admin (service_role) клиенты
│       ├── telegram/                bot.ts (singleton) + handle-update.ts + templates.ts
│       ├── tool-handlers/           реализация ToolHandlers для агента (4 tools)
│       ├── loveandpay/              клиент + подпись + webhook-handlers (приём RUB)
│       ├── pay-space/               клиент PaySpace (выпуск USD-карт) + sign + format
│       ├── jobs/                    логика cron-джобов + dispatcher
│       ├── chat/                    session (cookie) + history веб-чата
│       ├── catalog/                 кнопочный флоу каталога (happy path без AI)
│       ├── cabinet/                 логика личного кабинета
│       ├── ai/                      дневной токен-бюджет (budget.ts)
│       └── security/                timing-safe сравнения и пр.
│
└── packages/
    ├── types/   @oplati/types  — Zod-схемы и state machine заказа (источник правды контрактов)
    │   └── src/  order-state-machine.ts · loveandpay.ts · paypace.ts · telegram*.ts · index.ts
    ├── db/      @oplati/db     — Drizzle schema + repositories + migrations
    │   └── src/  schema.ts (12 таблиц) · repositories/* (users, orders, payments, cards, …)
    └── agent/   @oplati/agent  — AI-агент; НЕ импортирует db (только через ToolHandlers)
        └── src/  index.ts (runAgent) · client.ts · prompts.ts · router.ts · tools.ts
```

### API-эндпоинты (`apps/web/app/api/`)

| Маршрут | Назначение |
|---|---|
| `POST /api/bot` | Telegram webhook (grammY). Проверка `X-Telegram-Bot-Api-Secret-Token`; единственный non-200 кейс → `401`. |
| `POST /api/chat` · `/chat/history` · `/chat/clear` | Веб-чат: тот же `runAgent()`, история, сброс. Сессия по cookie. |
| `POST /api/auth/telegram/link` · `/link/status` | Привязка Telegram к веб-сессии (одноразовый токен, deep-link, поллинг статуса). |
| `POST /api/orders/propose` · `/confirm` · `GET /status` | Предложение / подтверждение / статус заказа. |
| `GET /api/catalog` | Каталог сервисов (кнопочный флоу). |
| `POST /api/payments/create` | Внутренний (`X-Internal-Token`): создание инвойса Love&Pay. |
| `POST /api/payments/loveandpay` | Webhook Love&Pay (подпись, идемпотентность, `invoice.paid` → `paid`). |
| `GET /api/profile` · `/api/cabinet` | Профиль и данные личного кабинета. |
| `/api/cron/*` | 5 джобов (см. ниже), вызываются Vercel Cron. |
| `/api/admin/telegram-webhook` | set/get/delete webhook бота (`X-Internal-Token`). |
| `GET /api/health` | Healthcheck. |

### Cron-джобы (`vercel.json` → `/api/cron/*` → `lib/jobs/*`)

| Джоб | Расписание | Что делает |
|---|---|---|
| `poll-payment` | `*/5 * * * *` | Подстраховка от потерянных webhook'ов L&P + recovery зависших в `paid` (повтор `issue-card`). |
| `expire-payments` | `*/15 * * * *` | Истечение неоплаченных инвойсов. |
| `renewal-reminder` | `0 7 * * *` | Напоминания о продлении подписок. |
| `recycle-cards` | `30 3 * * *` | `active→idle` (90д), `idle→release`+`recycled` (180д), алёрт низкого VCC-баланса. |
| `keepalive` | `0 */6 * * *` | Анти-автопауза Supabase free tier. |

---

## Границы пакетов (строго!)

| Пакет | Может импортировать | Запрещено |
|---|---|---|
| `@oplati/types` | только `zod` | `@oplati/*` |
| `@oplati/db` | `@oplati/types` | `@oplati/agent`, `apps/web` |
| `@oplati/agent` | `@oplati/types` | **`@oplati/db` напрямую** (только через `ToolHandlers`) |
| `apps/web` | все `@oplati/*` | — |

Импорты — только через barrel или объявленные subpath-exports (`@oplati/db`,
`@oplati/db/schema`, `@oplati/agent/tools`); приватные пути (`@oplati/db/src/...`) и
`../../../` cross-package imports запрещены.

## Ключевые архитектурные инварианты

Полный список — в [`CLAUDE.md`](./CLAUDE.md). Самое важное:

1. **`order_events` — append-only.** Изменение статуса = новая строка в той же транзакции, что меняет `orders.status`.
2. **State-переходы заказа — только через `transitionOrder()`** (`packages/db/src/repositories/orders.ts`); разрешённые переходы — `packages/types/src/order-state-machine.ts`.
3. **Идемпотентность webhook'ов** — `UNIQUE(provider, provider_ref)` + `ON CONFLICT DO NOTHING`; атомарный claim `pending→succeeded` гарантирует, что побочные эффекты выполнит один из конкурентных вызовов.
4. **Деньги — integer в минимальных единицах** (`amount_rub` — копейки, USD — центы). Никогда `float`/`numeric`.
5. **Zod на всех границах** (webhook body, Telegram updates, tool inputs, URL params).
6. **Webhook endpoints всегда `200 OK`** (исключение — `/api/bot` → `401` при неверном secret-token).
7. **Полные PAN/CVC никогда не пишутся в логи/БД/Sentry** — только `pan_masked`; полные реквизиты уходят клиенту единственным путём — сообщением в Telegram.

---

## Запуск и разработка

```bash
pnpm install                            # установка (один раз)
pnpm dev                                # все пакеты в watch
pnpm --filter web dev                   # только Next.js
pnpm build                              # production build
pnpm typecheck                          # tsc --noEmit во всех workspace
pnpm lint                               # eslint

# Тесты
pnpm --filter web test                  # Vitest в apps/web
pnpm --filter @oplati/types test        # Vitest в packages/types

# Миграции БД (forward-only через Drizzle — НЕ править БД в обход)
pnpm --filter @oplati/db db:generate    # сгенерировать миграцию из schema.ts
pnpm --filter @oplati/db db:migrate     # применить миграции
pnpm --filter @oplati/db db:seed        # seed каталога сервисов
pnpm --filter @oplati/db db:studio      # Drizzle Studio
```

**Требования:** Node.js ≥ 24, pnpm 9. Переменные окружения валидируются через `apps/web/lib/env.ts`
(Zod, lazy). Реальные токены — только в Vercel env (Sensitive) и локальном `.env.local`/`.env`
(gitignored); никогда не коммитить.

> ⚠️ **Не использовать** prod Supabase / Telegram-бот / кабинет Love&Pay для локальной разработки.

---

## Деплой

Vercel `fra1`. Два окружения с **раздельными Telegram-ботами** (webhook у бота один — шарить нельзя):

- **Production** — `https://oplati-podpisku-web.vercel.app`. Бот `@test_prodipsa_bot`. Auto-deploy на merge в `main`.
- **Preview** — branch-alias на каждый push в feature-ветку. Бот `@dev_test_podpiska_bot`.

Детали окружений, секретов и перерегистрации webhook — в [`CLAUDE.md`](./CLAUDE.md) (раздел Deployments).

---

## База данных

Supabase Postgres, Drizzle ORM, RLS включён. 12 таблиц (схема — `packages/db/src/schema.ts`):
`users`, `link_tokens`, `staff`, `conversations`, `messages`, `services` (каталог),
`orders`, `order_events`, `payments`, `cards`, `attachments`, `ai_usage_daily`.

Как устроена БД — [`docs/database.html`](./docs/database.html). Миграции — только forward-only
через Drizzle (см. `CLAUDE.md` → Миграции БД).
