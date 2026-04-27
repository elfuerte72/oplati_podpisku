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

### Added

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

- ✅ Closed: `Next.js app apps/web`, `Telegram webhook + AI v1` (см. [`.ai-factory/ROADMAP.md`](./.ai-factory/ROADMAP.md)).
- 🟡 Partially: `Preview-деплой (Vercel fra1)` — деплой-инфра настроена и работает (prod + preview, smoke прошёл на dev-боте); финал milestone — end-to-end smoke с **записью в Supabase**, что требует следующего milestone «Базовая схема БД».
- ➡️ Next: `Базовая схема БД` (`users`, `conversations`, `messages` через Drizzle).

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
