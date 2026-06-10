# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Источник правды — код + этот файл.** Старая спецификация (24 файла в `docs/`, спека-first workflow, ai-factory) удалена 2026-06-10 — история в git. Текущая `docs/` — справочная документация: [`docs/architecture.md`](docs/architecture.md) (архитектура и устройство кодовой базы), [`docs/database.html`](docs/database.html) (как работает БД), [`docs/CHANGELOG.md`](docs/CHANGELOG.md). Если поведение не очевидно из кода — спросите владельца, не додумывайте.

## О проекте

Telegram-бот + веб-чат для оплаты иностранных подписок русскоязычным пользователям. Клиент пишет, что хочет оплатить, — AI-агент «Оплатишка» находит цену, создаёт заказ, принимает оплату в RUB; исполнение пока ручное (операторы). Масштаб старта — ~50 заказов/день.

**Стек:** TypeScript 5.6 · Node.js 24 · pnpm + Turborepo · Next.js 16 (App Router) · grammY · `@anthropic-ai/sdk` (свой tool-loop, default-модель `claude-sonnet-4-6`, override через `ANTHROPIC_MODEL`) · Supabase Postgres (Storage/Auth/Realtime) · Drizzle · Zod · Tailwind v4 · Sentry + pino · Vitest · Vercel `fra1` + Vercel Cron.

**Осознанно НЕ используем** (не предлагать без явного запроса): Vercel AI SDK и токен-стриминг (чат целевой, короткие ответы; свой tool-loop работает в проде), Trigger.dev (хватает Vercel Cron; env зарезервирован), Upstash Ratelimit (заложен в env, не подключён), shadcn/ui (свой комикс-UI).

## Что работает сейчас

- **Telegram-бот → `/api/bot`** — grammY webhook (проверка `X-Telegram-Bot-Api-Secret-Token`, единственный non-200 кейс → `401`) → `runAgent()` из `@oplati/agent` → Anthropic → tools → Supabase. Диалог синхронно пишется в БД с graceful degradation при её недоступности (бот отвечает, но «забывает» историю).
- **Веб-чат → `/api/chat`** — тот же `runAgent()` (инвариант: оба канала используют одного агента), ответ JSON-ом без стриминга. История — `/api/chat/history`, сброс — `/api/chat/clear`, сессия по cookie (`lib/chat/session.ts`). Комикс-UI «Оплатишка» (`components/chat/`, `components/comic/`, skill `oplatishka-design`).
- **Tools агента** (`packages/agent/src/tools.ts`): `web_search` (серверный tool Anthropic — актуальные цены, в каталоге цен НЕТ), `search_catalog`, `propose_order`, `confirm_order`, `request_human`. Заказ принимается на **любой** сервис: из каталога (`serviceId`) или вне его (`customDescription` — свободный текст, оператор перепроверит). Комиссия 10% (`COMMISSION_PERCENT`), курс USDT→RUB при `propose_order`.
- **Платежи — Love&Pay (RUB)**: `confirm_order` → `POST /api/payments/create` (внутренний, защита `X-Internal-Token`) создаёт инвойс → клиент платит по ссылке → webhook `/api/payments/loveandpay` (подпись, идемпотентность, `invoice.paid` → `transitionOrder(paid)` + Telegram-уведомление клиенту). **Внимание:** тестовая панель кабинета L&P шлёт фейковый формат событий — реальный контракт (`invoice.paid`, `data.id`) снят живым вызовом, см. `lib/loveandpay/handlers.ts`.
- **Статус заказа**: `/api/orders/status`, подтверждение — `/api/orders/confirm`.
- **Cron (vercel.json → `/api/cron/*` → `lib/jobs/*`)**: `poll-payment` (каждые 5 мин, подстраховка от потерянных webhook'ов), `expire-payments` (15 мин), `renewal-reminder` (07:00), `recycle-cards` (03:30), `keepalive` (каждые 6 ч — анти-автопауза Supabase free tier).
- **Handoff оператору — НЕ реализован.** `request_human` пишет event `handoff_requested` в `order_events` (дедуп 5 мин, проверка принадлежности orderId) и сообщает SLA по `isWithinOperatorHours`. Целевая схема — Telegram forum-topics (один topic = один заказ, `/ai_back` возвращает AI), к ней пока не приступали.
- **Тесты**: Vitest в `apps/web` (loveandpay: client/sign/handlers) и `packages/types` (state machine, схемы L&P).

## Фаза 2 — виртуальные карты (PaySpace), в работе

План фазы с шагами и открытыми решениями — [`PLAN.md`](PLAN.md).

Карты выпускает **app.pay.space** (это НЕ Love&Pay; L&P — только приём RUB). Уже в коде: таблица `cards` (enum `card_status = active/idle/recycled`), репозиторий, клиент `lib/pay-space/` (`createCard`/`topupCard`/`getCard`), job `issue-card` (вызывается из L&P-webhook: topup активной карты → recycle чужой → выпуск новой → реквизиты клиенту в Telegram → `paid → in_fulfillment → completed` как `system`), cron `recycle-cards` (90 дней → `idle`, 180 → `recycled`).

**Выпуск выключен**: без `PAYSPACE_API_KEY` + `PAYSPACE_ACCOUNT_ID` guard `skipped_no_paypace` оставляет заказ в `paid` (ручной fulfillment). **Блокеры до написания кода**: контракт PaySpace не подтверждён живым вызовом (Zod-схемы в `packages/types/src/paypace.ts` — гипотеза; урок L&P — не доверять до живого вызова); не решено, что триггерит заморозку карты после оплаты сервиса (webhook PaySpace / freeze сразу после выдачи / оператор вручную); нет статуса `frozen` и методов freeze/unfreeze. Не выдумывать контракт — ждать доки/доступ от владельца.

**Безопасность реквизитов:** полные `pan`/`cvc` никогда не пишутся в логи/БД/Sentry (только `pan_masked`); полные реквизиты уходят клиенту единственным путём — сообщением в Telegram.

## Структура

```
apps/web/          Next.js 16 — единый деплой: веб-чат (page.tsx), API, в будущем админка
  app/api/bot/route.ts            Telegram webhook
  app/api/chat/                   route.ts (агент) + history/ + clear/
  app/api/payments/               create/ (инвойс L&P) + loveandpay/ (webhook)
  app/api/orders/                 confirm/ + status/
  app/api/cron/                   5 джобов, расписание в vercel.json
  app/api/admin/telegram-webhook/ set/get/delete webhook бота (X-Internal-Token)
  app/api/health/route.ts         Healthcheck
  components/chat/ + comic/       UI веб-чата (комикс-стиль)
  lib/env.ts                      Zod-валидация env (lazy) + env.server.ts (`server-only`)
  lib/logger.ts                   pino singleton + childLogger(module)
  lib/sentry.ts                   shared Sentry options + PII beforeSend
  lib/supabase/                   browser / server / admin (service_role) клиенты
  lib/telegram/                   bot.ts (singleton) + handle-update.ts + templates.ts
  lib/tool-handlers/              реализация ToolHandlers (4 tools)
  lib/loveandpay/                 клиент + подпись + webhook-handlers (+ тесты)
  lib/pay-space/                  клиент PaySpace (фаза 2)
  lib/jobs/                       логика cron-джобов + dispatcher
  lib/chat/                       session + history веб-чата
packages/types/    Zod-схемы и state machine заказа — источник правды контрактов
packages/db/       Drizzle schema (src/schema.ts, 10 таблиц) + repositories + drizzle/
packages/agent/    AI-агент (runAgent/runAgentNoTools), промпты, tool-схемы; НЕ импортирует db
docs/              справочная документация (architecture.md, database.html, CHANGELOG.md)
```

Таблицы БД: `users`, `staff`, `conversations`, `messages`, `services` (каталог, без цен), `orders`, `order_events`, `payments`, `cards`, `attachments`. RLS включён.

## Границы пакетов (строго!)

| Пакет | Может импортировать | Запрещено |
|---|---|---|
| `@oplati/types` | только `zod` | `@oplati/*` |
| `@oplati/db` | `@oplati/types` | `@oplati/agent`, `apps/web` |
| `@oplati/agent` | `@oplati/types` | **`@oplati/db` напрямую** (через `ToolHandlers`) |
| `apps/web` | все `@oplati/*` | — |

`@oplati/agent` общается с БД только через интерфейс `ToolHandlers` (реализация в `apps/web/lib/tool-handlers/`). Импорты — только через barrel или объявленные subpath-exports (`@oplati/db`, `@oplati/db/schema`, `@oplati/agent/tools`); приватные пути (`@oplati/db/src/...`) и `../../../` cross-package imports запрещены.

## Архитектурные инварианты (не нарушать)

1. **`order_events` — append-only.** Никогда не `UPDATE`/`DELETE`. Любое изменение статуса = новая строка в той же транзакции, что меняет `orders.status`. RLS это форсит.
2. **Идемпотентность webhook'ов** — `UNIQUE(provider, provider_ref)` на `payments` + `INSERT ... ON CONFLICT DO NOTHING`. Повторный вызов не создаёт дубль или двойной переход.
3. **Деньги — integer в минимальных единицах.** `amount_rub` — копейки, `original_amount` и `balance_usd_cents` — USD-центы. Никогда `numeric`/`float`.
4. **State-переходы заказа — только через `transitionOrder()`** (`packages/db/src/repositories/orders.ts`). Прямой `UPDATE orders SET status` запрещён. Разрешённые переходы — `allowedTransitions` в `packages/types/src/order-state-machine.ts`.
5. **Zod на всех границах.** Webhook body, Telegram updates, AI tool inputs, URL params — парсятся схемой из `@oplati/types`. Не `any`, не `as T` без обоснования.
6. **Webhook endpoints всегда `200 OK`** (даже при невалидном input — ошибка в теле), иначе Telegram/L&P ретраят и забивают очередь. Исключение: `/api/bot` отдаёт `401` при неверном secret-token.

## Команды

```bash
pnpm install                            # установка (один раз)
pnpm dev                                # все пакеты в watch
pnpm build                              # production build
pnpm typecheck                          # tsc --noEmit во всех workspace
pnpm lint                               # eslint
pnpm --filter web dev                   # только Next.js
pnpm --filter web test                  # Vitest в apps/web
pnpm --filter @oplati/types test        # Vitest в packages/types
pnpm --filter @oplati/db db:generate    # сгенерировать миграцию из schema.ts
pnpm --filter @oplati/db db:push        # применить миграции к Supabase
pnpm --filter @oplati/db db:migrate     # применить через migrate (.env из корня)
pnpm --filter @oplati/db db:seed        # seed каталога сервисов
pnpm --filter @oplati/db db:studio      # Drizzle Studio
```

### Миграции БД

**Forward-only через Drizzle.** Схема — `packages/db/src/schema.ts`. Правка схемы → `db:generate` → `.sql` в `packages/db/drizzle/` → `db:push`. Никогда не редактировать применённую миграцию и не править БД через Supabase Dashboard в обход Drizzle. Destructive-изменения — только backwards-compatible (nullable-колонки, два деплоя на удаление).

## Deployments

Vercel `fra1`. Два окружения с **раздельными Telegram-ботами** (webhook у бота один → шарить нельзя):

- **Production** — `https://oplati-podpisku-web.vercel.app` (default-домен, custom не подключён). Бот `@test_prodipsa_bot`. Auto-deploy на merge в `main`.
- **Preview** — branch-alias `oplati-podpisku-web-git-<branch>-<team>.vercel.app` на каждый push в feature-ветку. Бот `@dev_test_podpiska_bot`. Перед merge — smoke-тест через dev-бота: webhook перерегистрируется на новый preview-URL.

**Vercel Deployment Protection: Disabled** — иначе Telegram получает `401` от обвязки Vercel до нашего кода. Защита — secret-token (`/api/bot`), подпись (L&P webhook), `X-Internal-Token` (внутренние endpoints), Supabase RLS.

### Telegram-секреты (где что лежит, без значений)

> Реальные токены — только в Vercel env (Sensitive) и локальном `.env.local`/`.env` (gitignored). Никогда не пастовать в файлы, коммиты, чат. Компрометация: `/revoke` у `@BotFather`, `openssl rand -hex 32` для нового webhook-secret.

| Бот | Vercel env (по окружениям) | Локально |
|---|---|---|
| `@test_prodipsa_bot` (prod) | Production: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` |
| `@dev_test_podpiska_bot` (dev) | Preview: те же имена, dev-значения | `TELEGRAM_BOT_TOKEN_DEV`, `TELEGRAM_WEBHOOK_SECRET_DEV` |

Остальные env (Supabase, Anthropic, APP_URL, Love&Pay) — общие для обоих окружений. **Vercel `Sensitive`-флаг:** `vercel env pull` отдаёт пустую строку — by design; аудит по бейджу «Updated» в UI. После смены секрета **обязателен redeploy** — старые деплои держат стейл значение и отвечают `401`.

**Webhook у бота один.** Смена preview-URL → перерегистрировать webhook dev-бота; после merge — `deleteWebhook`. Без раскрытия токена: `POST/GET/DELETE /api/admin/telegram-webhook` (защита `X-Internal-Token`).

## Конвенции кода

- **`strict: true`** + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`. `any` запрещён; `unknown` + Zod narrow.
- **Never swallow errors** — `catch {}` и `catch { console.log }` запрещены: либо re-throw, либо `Sentry.captureException` + structured error.
- **Result pattern** для ожидаемых неудач (`{ ok: false, reason }`); `throw` — для неожиданного.
- **`console.log` запрещён** в production-коде — только `logger.*` (pino). PAN/CVC/токены не логируются никогда.
- **`fetch` без timeout запрещён** — всегда `AbortController`.
- **Именование:** `camelCase` функции, `PascalCase` типы/классы, `UPPER_SNAKE_CASE` compile-time константы, `snake_case` БД, `kebab-case.ts` файлы, `PascalCase.tsx` компоненты.
- **Commits — Conventional Commits** (`feat(agent):`, `fix(payments):`); squash merge; заголовок ≤ 72 символа.
- **RSC по умолчанию**, `"use client"` — только где нужен браузерный API.
- Graceful degradation на внешних зависимостях (Anthropic, БД): понятный ответ пользователю, не 500.

## MCP-серверы

`.mcp.json`: `github`, `filesystem`, `chromeDevtools`, `playwright`, `supabase` (HTTP MCP, `project_ref=nyxijwpuvctmvemaemqn`, OAuth при первом использовании). Через Supabase MCP можно `execute_sql`/`list_tables` для чтения и отладки — но миграции только через Drizzle.

## Что запрещено

- Кросс-импорты между `apps/*`, циклы между пакетами, импорт приватных путей пакетов.
- `pnpm --filter @oplati/db db:push --force` на prod.
- Commit `.env*` / реальных токенов (`.gitignore` покрывает — не отключать).
- Использовать prod Supabase / Telegram-бот / кабинет Love&Pay для локальной разработки.
- Эмодзи в коде, комментариях, логах (в русских UI-строках — можно, если требует продукт).
- Логировать или сохранять полные PAN/CVC карт.
- Выдумывать контракт внешнего API (PaySpace, L&P) — только подтверждённый живым вызовом или докой владельца.
