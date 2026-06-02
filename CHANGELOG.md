# Changelog

Все заметные изменения проекта документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версионирование — [Semantic Versioning](https://semver.org/lang/ru/).

Подробные записи по дням работы — в [`.ai-factory/Journal/`](./.ai-factory/Journal/).
Post-mortem'ы инцидентов — в [`.ai-factory/patches/`](./.ai-factory/patches/).
Roadmap и milestone'ы — в [`.ai-factory/ROADMAP.md`](./.ai-factory/ROADMAP.md).

---

## [Unreleased]

Изменения в `main`, ещё не задеплоенные в production.

### Fixed

- **Бот «потерял память» — пустая БД + молчаливая деградация в амнезию** ([post-mortem 2026-06-02](./.ai-factory/patches/2026-06-02-14.30.md))
  - Симптом: бот переспрашивает уже сказанное и не создаёт заказы (амнезия), при этом логи Vercel — зелёные `200 OK`. Память в коде (`loadRecentMessages` перед `runAgent`) реализована корректно — ломала её пустая БД.
  - Root cause: боевая Supabase `nyxijwpuvctmvemaemqn` (общая для preview и prod) имела пустую `public`-схему (0 таблиц). Любой DB-вызов падал → `persistInbound` возвращал `null` → `ctx === null` → fallback `runAgentNoTools([только текущее сообщение])` (без истории и без tools). Изначально миграции накатывались через Supabase MCP `apply_migration` (трекинг в `supabase_migrations`, не в drizzle); после потери таблиц на free-tier их никто не накатил заново — **не было команды `db:migrate`**.
  - Fix: `restore_project` из `INACTIVE` → применены 7 миграций через `drizzle-kit migrate` (10 таблиц + 27 services) → проверен конвейер памяти на живой БД реальными repo-функциями → тестовые строки удалены.
  - `LoveAndPay` протестирован (read-only `GET /api/v2/rates`): связность + HMAC-подпись + API-ключ валидны (404 `RATE_NOT_FOUND`, не 401); фикс. курс USDT/RUB на аккаунте не задан → штатный `RATE_FALLBACK_USDT_RUB`.

### Added

- **`db:migrate` — недостающая команда применения миграций** ([post-mortem 2026-06-02](./.ai-factory/patches/2026-06-02-14.30.md))
  - `packages/db/package.json`: `db:migrate` = `node --env-file=../../.env node_modules/drizzle-kit/bin.cjs migrate`. Применяет ВЕСЬ набор миграций по журналу (включая hand-written RLS `0001`/`0005` и seed `0006`) — в отличие от `db:push`, который диффит только `schema.ts`. Forward-only, идемпотентно. drizzle-kit сам `.env` не читает, а `.bin/drizzle-kit` — shell-shim (не запускается через `node`), отсюда явный путь к `bin.cjs`.
  - Сверён трекинг `drizzle.__drizzle_migrations` (7 строк, `hash = sha256(.sql)`, `created_at = journal.when`) — чтобы `db:migrate` был чистым no-op на уже накатанной БД и применял только новые миграции.

- **Расширение схемы БД — services / orders / order_events / payments / attachments + seed каталога** ([Journal 17-05-2026](./.ai-factory/Journal/db-extended-schema/17-05-2026.md), план [`feature-db-extended-schema.md`](./.ai-factory/plans/feature-db-extended-schema.md))
  - `packages/db/src/schema.ts`: добавлены 5 таблиц и 5 enum'ов. `services` (публичный каталог, БЕЗ RLS), `orders` (с CHECK `orders_service_or_custom` — заказ обязан ссылаться либо на услугу из каталога, либо иметь кастомное описание), `order_events` (append-only audit log с FK CASCADE на orders), `payments` (UNIQUE `(provider, provider_ref)` — основа идемпотентности webhook'ов), `attachments` (Supabase Storage refs с FK SET NULL — файлы переживают удаление order/message). Enum'ы: `order_status` (13 значений), `payment_provider`, `payment_status`, `attachment_kind`, `actor_type`. Все суммы — `integer` копейки.
  - `@oplati/types`: добавлены zod-схемы `paymentProvider`, `paymentStatus`, `attachmentKind`, `actorType` — синхронизированы byte-for-byte с pgEnum'ами в `@oplati/db`. `paymentWebhookEvent.provider` оставлен inline (внешний контракт уже значений, чем внутренний enum).
  - `@oplati/db` теперь явно зависит от `@oplati/types` (`workspace:*`) — нужен для `import type { PricingPolicy, OrderParameters }` в schema.ts. Это явно разрешено границами пакетов в CLAUDE.md.
  - Auto-migration `packages/db/migrations/0003_common_richard_fisk.sql` сгенерирована через `db:generate`. Drizzle при `.enableRLS()` сразу эмитит `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` — отдельная RLS-миграция не понадобилась (запланированный `0004_enable_rls_extended.sql` стал no-op).
  - **DDL применился через Supabase MCP `apply_migration`**, не через `db:push`: drizzle-kit `db:push` падает на DNS-резолве `db.<ref>.supabase.co` (Supabase перевёл free-tier на pooler-only). Это меняет workflow: `db:generate` → закоммитить `.sql` → `apply_migration` через MCP с тем же содержимым. Записывается в `supabase_migrations.schema_migrations` (audit trail на стороне Supabase).
  - Seed-скрипт `packages/db/scripts/seed-catalog.ts` — 10 услуг (Claude Pro, ChatGPT Plus, Netflix Premium, Spotify Premium, Airbnb, YouTube Premium, Discord Nitro, Midjourney Basic, LinkedIn Premium, Apple One) с правильным `requires_kyc` (true для Airbnb / LinkedIn Premium / Apple One). Идемпотентный UPSERT по `slug` через `onConflictDoUpdate` — повторный запуск безопасен. Перед каждым INSERT — `pricingPolicy.parse()` (Zod на границах, инвариант CLAUDE.md). Placeholder-цены на основе USD-прайса × курс ~95₽ × margin 15% — помечены `TODO: верифицировать с владельцем перед production`.
  - Airbnb получил dummy tier `{name: 'Booking', priceRub: 1, originalAmount: 1}` — фактическая цена per-booking хранится в `orders.amount_rub`. Альтернатива (ослабить zod до `nonnegative()`) отвергнута; долгосрочно может прийти discriminated union `pricingKind: 'tier' | 'per_booking'`.
  - `pnpm --filter @oplati/db db:seed` через `tsx --env-file=../../.env` — добавлены `tsx` (devDep) и `pino` (dep) в `@oplati/db`. Использует pooler с `prepare: false`.
  - **Supabase project был в `INACTIVE` (auto-pause)** — выполнен `restore_project` (~60s). Базовые 4 таблицы + RLS пережили паузу.
  - Smoke verified: 9 таблиц / 9 enum'ов в `public`; CHECK `orders_service_or_custom` падает с `23514`; повторный INSERT в `payments` с теми же `(provider, provider_ref)` падает с `23505`; FK CASCADE `orders → order_events` работает; `services.relrowsecurity = false`, остальные 4 новые — `true`.
  - `pnpm typecheck && pnpm lint && pnpm build` — green.
- **Preview-деплой Vercel fra1 + persist Telegram dialog** ([Journal 30-04-2026](./.ai-factory/Journal/preview-deploy-vercel/30-04-2026.md), [merged](./.ai-factory/Journal/preview-deploy-vercel/merged.md), [PR #7](https://github.com/elfuerte72/oplati_podpisku/pull/7))
  - Repository-функции в `@oplati/db`: `getOrCreateUserByTelegramId` (raw-SQL upsert через partial unique `WHERE telegram_id IS NOT NULL`, `(xmax = 0)` для отличия INSERT от UPDATE, hash-PII в логах), `getOrCreateActiveConversation` (select-or-insert по `(user_id, channel)`), `appendMessage` (append-only INSERT с warn'ом на `role='operator'` без `staff_id`).
  - Минимальный `RepoLogger` интерфейс (pino-shape, `debug/info/warn`) — пакет `@oplati/db` остаётся без зависимости от pino.
  - `/api/bot` и `/api/health` пиннятся к `preferredRegion='fra1'` + `maxDuration` (30s/5s) — закрыт техдолг по `docs/deployment.md`.
  - `apps/web/lib/telegram/handle-update.ts` синхронно пишет диалог в Supabase до возврата `200 OK`: для `/start` — пара (user `/start` + assistant GREETING с `meta.source='static_greeting'`); для текстовых сообщений — user-msg перед AI-call, assistant-msg после с `meta.usage.{input,output}_tokens`. AI-history НЕ загружается из БД (audit-log only) — отложено на milestone «State machine + AI tools».
  - Graceful degradation: ошибки БД глотаются с `Sentry.captureException` + structured log; webhook не молчит при падении Postgres.
  - End-to-end smoke на dev-боте подтверждён: пара probe + реальный диалог дали 6 строк в `messages` (3 пары user/assistant), 1 `conversations`, 1 `users`; meta-поля корректны; latency 1.3-2.0s wall на AI round-trip; региональная резолюция `fra1::iad1` подтверждена через `x-vercel-id`.
- **Vercel deployments — Production + Preview** ([Journal 27-04-2026](./.ai-factory/Journal/telegram-webhook-ai-v1/27-04-2026.md), [docs/deployment.md](./docs/deployment.md))
  - **Production**: `https://oplati-podpisku-web.vercel.app` (default Vercel-домен; custom-домен — будущий milestone). Telegram-бот `@test_prodipsa_bot`. Деплой автоматически на merge в `main`.
  - **Preview**: branch-alias `oplati-podpisku-web-git-<branch>-<team>.vercel.app` на каждый PR. Telegram-бот `@dev_test_podpiska_bot` (отдельный, чтобы webhook'и не конфликтовали с prod). Деплой автоматически на push в feature-ветку.
  - В Vercel env `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` разделены по окружениям; остальные переменные (Supabase, Anthropic, APP_URL, DATABASE_URL*) — общие.
  - **Vercel Deployment Protection: Disabled** — иначе Telegram-сервера получают `401` от Vercel SSO до нашего кода; защита остаётся через secret-token / HMAC / RLS у соответствующих endpoint'ов.
  - Smoke прошёл на `@dev_test_podpiska_bot` через preview branch-alias: `/start` → `GREETING`, 4 свободных сообщения → AI Haiku 4.5 (2.3-4.7s, ~950 tokens/msg).
- **Telegram webhook + AI v1** ([Journal 27-04-2026](./.ai-factory/Journal/telegram-webhook-ai-v1/27-04-2026.md), [PR #2](https://github.com/elfuerte72/oplati_podpisku/pull/2))
  - `POST /api/bot` (grammY, Node runtime) с проверкой `X-Telegram-Bot-Api-Secret-Token`; webhook всегда отвечает `200 OK`, кроме невалидного secret-token (`401`).
  - Stateless round-trip: `runAgentNoTools()` в `@oplati/agent` — Claude **Haiku 4.5** с `SYSTEM_PROMPT` консультанта, без tools (`ANTHROPIC_MODEL=claude-haiku-4-5`; Opus здесь излишен и кратно дороже).
  - `/start` → `GREETING`; обычный текст → ответ AI; длинные ответы (> 4096) режутся по строкам через `splitForTelegram`.
  - `telegramUpdateSchema` в `@oplati/types` — минимальный Zod-slice (`update_id`, `message.{chat, from?, text?}`).
  - `lib/telegram/{bot.ts, handle-update.ts}` — lazy-init Bot + диспатч с verbose-логированием (тексты сообщений в логи не попадают, `*.text` редактируется на уровне pino).
- **Next.js 16 baseline в `apps/web/`** ([PR #1](https://github.com/elfuerte72/oplati_podpisku/pull/1), 2026-04-22)
  - App Router + Tailwind v4 + TypeScript strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
  - Интеграция с pnpm/Turborepo: `transpilePackages`, workspace-зависимости `@oplati/{agent,db,types}`.
  - `apps/web/app/api/health/route.ts` — healthcheck для uptime-мониторинга.
  - Плейсхолдер-лендинг (`lang=ru`, `robots: noindex`).
- **Observability baseline**
  - Structured logger (pino) с JSON stdout, pino-pretty в dev, redact для секретов и PII денилиста (`content/message/text/email/phone/card/password/token` + все env-токены).
  - Sentry на трёх runtime (client/server/edge) с `beforeSend` PII-скраббером и пропуском init без DSN.
  - `instrumentation.ts` с fail-fast валидацией env на старте Node-процесса.
- **Supabase SSR-клиенты**
  - `lib/supabase/browser.ts` — singleton для Client Components, только `NEXT_PUBLIC_*` ключи.
  - `lib/supabase/server.ts` — через `cookies()` из `next/headers`, с no-op для read-only RSC.
  - `lib/supabase/admin.ts` — `service_role` + `import 'server-only'` (bypass RLS, только server).
- **Env-валидация через Zod** (`apps/web/lib/env.ts`)
  - Lazy Proxy-getter — не падает в `next build` без `.env.local`.
  - Helper `optionalEnvString` — корректная обработка пустых строк в `.env.local`.
  - Разделение `serverEnv` / `clientEnv`; re-export через `env.server.ts` с `server-only`.

### Fixed

- **`drizzle-orm` bump до `^0.45.2`** — закрывает CVE [GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9) (SQL injection через improperly escaped identifiers, fix в `>=0.45.2`). `drizzle-kit` bump до `^0.31.10` для совместимости. API drizzle-orm/pg-core (`pgTable`, `pgEnum`, `uuid`, `timestamp`, `index`, ...) стабилен между 0.36 и 0.45 — никаких правок в `packages/db/src/schema.ts` не понадобилось. На момент bump'а БД-миграций ещё нет, эксплуатация не реализуема — но CI security-гейт правильно блокировал merge до фикса.
- **`APP_URL` failure в Vercel Production env** — `instrumentation.ts` падал с `Invalid url` на cold-start (ошибка обнаружилась через `vercel logs` после первого деплоя). Поправлено указанием `https://oplati-podpisku-web.vercel.app` в Production env-переменной (Zod в `apps/web/lib/env.ts:46` требует валидный URL). Без redeploy исправление не применяется — стандартный Vercel-flow.
- **`.env.example` schema drift** ([patch 2026-04-22-22.44](./.ai-factory/patches/2026-04-22-22.44.md))
  Добавлено 9 переменных, которые использовались в коде, но отсутствовали в шаблоне
  (`NEXT_PUBLIC_SUPABASE_*`, `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_APP_URL`, `LOG_LEVEL`,
  `UPSTASH_*`, `TRIGGER_*`). Заменены real-looking значения на placeholder'ы, чтобы не
  провоцировать копирование реальных секретов. Near-miss: реальные Supabase-ключи
  кратковременно оказались в `.env.example` локально, но не были закоммичены.
- **Zod `.optional()` падал на пустых строках из `.env.local`** ([patch 2026-04-23-00.00](./.ai-factory/patches/2026-04-23-00.00.md))
  При первом `pnpm --filter web dev` все опциональные переменные (Telegram, YooKassa,
  Upstash, Sentry) проваливали валидацию, т.к. `.optional()` пропускает только `undefined`,
  а пустая строка — это валидная `string`, которая потом падает на `.min(1)` / `.url()`.
  Введён helper `optionalEnvString` с preprocess `"" → undefined`. `ANTHROPIC_API_KEY`
  переведён в optional до Sprint 1.5 (Telegram + AI).

### Infrastructure

- **`.gitignore`** — добавлены `Screenshot*.{png,jpg,jpeg}` (macOS-скриншоты в корне) и `.smoke/` (локальные логи туннелей и dev-сервера). `.vercel/` — закрыт после `vercel link` для CLI.

### Roadmap

- ✅ Closed: `Next.js app apps/web`, `Telegram webhook + AI v1`, `Базовая схема БД`, `Preview-деплой (Vercel fra1)`, `Расширение схемы БД` (см. [`.ai-factory/ROADMAP.md`](./.ai-factory/ROADMAP.md)).
- ➡️ Next: `State machine заказа + AI tools` — repository-функции (`createOrder`, `transitionOrder`, `appendOrderEvent`, `recordPayment`, `listActiveServices`), генератор `short_id` (nanoid), AI-tools (`search_catalog`, `propose_order`, `confirm_order`, `request_human`), DB-уровень enforcement append-only `order_events`.

---

## [0.0.1] — 2026-04-22 — Project bootstrap

Первый milestone до начала этого CHANGELOG; историческая справка.

### Added

- pnpm + Turborepo монорепа, workspace-каркасы `@oplati/{agent,db,types}`.
- Полная спецификация проекта в `docs/` (24 файла: PRD, architecture, state machine, API, payments, security, observability, roadmap, etc.).
- `CLAUDE.md` + `AGENTS.md` — правила для AI-агентов и карта проекта.
- MCP-конфиг: `.mcp.json` с github, filesystem, chromeDevtools, playwright, supabase.
- GitHub Actions workflows: typecheck / lint / tests / security audit (Sprint 2 детали в milestone'ах roadmap).
- `.ai-factory/` — установлены aif-скиллы (22 штуки), ROADMAP, DESCRIPTION, ARCHITECTURE (thin pointers).
