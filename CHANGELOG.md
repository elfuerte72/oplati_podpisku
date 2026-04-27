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

- **Telegram webhook + AI v1** ([Journal 2026-04-27](./.ai-factory/Journal/2026-04-27-telegram-webhook-ai-v1.md))
  - `POST /api/bot` (grammY, Node runtime) с проверкой `X-Telegram-Bot-Api-Secret-Token`; webhook всегда отвечает `200 OK`, кроме невалидного secret-token (`401`).
  - Stateless round-trip: `runAgentNoTools()` в `@oplati/agent` — Claude (Opus 4.6) с `SYSTEM_PROMPT` консультанта, без tools.
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

### Roadmap

- ✅ Closed: `Next.js app apps/web` (см. [`.ai-factory/ROADMAP.md`](./.ai-factory/ROADMAP.md)).
- ➡️ Next: `Telegram webhook + AI v1`, `Базовая схема БД`, `Preview-деплой (Vercel fra1)`.

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
