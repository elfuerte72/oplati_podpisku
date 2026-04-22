# Plan — Next.js app `apps/web`

**Branch:** `feature/nextjs-app`
**Created:** 2026-04-22
**Mode:** full (no `--parallel`)

## Settings

- **Testing:** нет (бизнес-логики ещё нет; Vitest планируется в Sprint 2)
- **Logging:** verbose (DEBUG в dev/preview, INFO в prod; pino + JSON stdout)
- **Docs update:** нет (`docs/` — канонический, не трогаем; обновим только README «быстрый старт»)

## Roadmap Linkage

- **Milestone:** `Next.js app apps/web` (.ai-factory/ROADMAP.md)
- **Rationale:** Closes the second unchecked milestone after `Project bootstrap`. Scope strictly matches milestone text: «инициализация приложения, Supabase-клиенты (browser+server), Sentry baseline». Out of scope: `/api/bot` (grammY), схема БД, Vercel deploy — это последующие самостоятельные milestones.

## Context snapshot

- Монорепа pnpm + Turborepo уже готова: `packages/{agent,db,types}`, корневой tsconfig.base, turbo.json, workflows CI.
- `apps/web` **пустой** — создаём с нуля через `create-next-app`.
- Стек фиксирован `docs/tech-stack.md`: Next.js 16.x App Router, Node 24, TS 5.6+, Tailwind, Supabase (через `@supabase/ssr` + `@supabase/supabase-js`), Sentry `@sentry/nextjs`, logger pino, validation Zod.
- Границы: `apps/web` может импортировать все `@oplati/*`; клиенты Supabase живут в `apps/web/lib/supabase/`; реализация `ToolHandlers` — в `apps/web/lib/tool-handlers/` (этот план её ещё не создаёт).
- Env — см. `docs/env-vars.md`. Обязательные на этапе этого плана: Supabase (URL + anon + service role), Anthropic key (валидируется, но не используется ещё), APP_URL, Sentry DSN (опционально в dev).

## Invariants to respect

1. Границы пакетов (`agent` не импортирует `db` напрямую) — не нарушать.
2. `SUPABASE_SERVICE_ROLE_KEY` — только server-only (`import 'server-only'` в admin client).
3. PII-scrubbing в Sentry (`beforeSend`) — денилист из `docs/observability.md`: `content, message, text, email, phone, card, password, token`.
4. Zod на границах; `env.ts` падает на старте, а не silent fallback.
5. Никаких `console.log` в prod-коде — только `logger.*` (правило `docs/coding-standards.md`).
6. Без эмодзи в коде/конфигах (CLAUDE.md).
7. Barrel-экспорты пакетов — только через публичный `index.ts`.

## Tasks

### Phase 1 — Инициализация каркаса (tasks #1, #2)

- [x] **#1 Инициализировать Next.js 16 app в apps/web**
  `pnpm dlx create-next-app@latest apps/web --ts --app --tailwind --eslint --src-dir=false --import-alias="@/*" --use-pnpm`.
- [x] **#2 Интегрировать apps/web с монорепой** — `tsconfig` extends `../../tsconfig.base.json`; `next.config.ts` добавить `transpilePackages: ['@oplati/agent', '@oplati/db', '@oplati/types']`; `package.json` name=`web` + workspace-зависимости; добавить `typecheck` скрипт.

### Phase 2 — Наблюдаемость-основа: logger (tasks #7)

- [x] **#7 Logger (pino) в `apps/web/lib/logger.ts`** — JSON stdout, verbose в dev, redact для секретов; экспорт singleton + `child({ module })`. Self-test `logger.debug({ event:'logger.ready' })`.

> Вынесен перед env/supabase/sentry — чтобы остальные модули писали сразу через `logger`, а не через `console`.

### Phase 3 — Контракты окружения (tasks #3, #4)

- [x] **#3 Env-валидация через Zod (`apps/web/lib/env.ts`)** — разделить на `serverEnv` и `clientEnv` (`NEXT_PUBLIC_*`); пометить Telegram/YooKassa/CryptoBot/Upstash как `.optional()` на этом этапе. `import 'server-only'` на серверном блоке. Верхнеуровневый `env` — **lazy getter** (иначе build упадёт без `.env.local`).
- [x] **#4 Supabase-клиенты** — три factory: browser (`@supabase/ssr.createBrowserClient`), server (`createServerClient` с cookies из `next/headers`), admin (`createClient` с service_role + `import 'server-only'`). Verbose-лог при первой инициализации каждого.

### Phase 4 — Sentry baseline (tasks #5, #6)

- [x] **#5 Конфиги Sentry** — `sentry.{client,server,edge}.config.ts`, `lib/sentry.ts` с `beforeSend`-скраббером по денилисту PII. Environment = `VERCEL_ENV ?? NODE_ENV`.
- [x] **#6 Instrumentation** — `instrumentation.ts` (server/edge через NEXT_RUNTIME) + `instrumentation-client.ts`; обернуть `next.config.ts` в `withSentryConfig({ silent: !CI, widenClientFileUpload: true, hideSourceMaps: true, disableLogger: true })`.

### Phase 5 — Минимальное UI + smoke endpoint (tasks #8, #9)

- [x] **#8 Лендинг** — `app/page.tsx` (RSC, placeholder «Оплати подписки — скоро») + `app/layout.tsx` с русским `lang`, metadata, Tailwind base.
- [x] **#9 Healthcheck** — `app/api/health/route.ts`, возвращает `{status,env,timestamp}`, `dynamic = 'force-dynamic'`. Verbose-лог на каждый hit.

### Phase 6 — Финализация (tasks #10, #11)

- [x] **#10 Smoke verify** — `pnpm install / typecheck / lint / build` проходят. Если build падает на env — сделать `env` lazy.
- [x] **#11 README «Быстрый старт»** — заменить шаг с `create-next-app` на «apps/web уже инициализирован»; добавить пункт про копирование `.env.example` → `apps/web/.env.local`. **Не трогать `docs/`** — источник правды.

## Commit Plan

| # | Commit | Tasks | Message |
|---|---|---|---|
| 1 | Каркас | #1, #2 | `feat(web): initialize Next.js 16 app and wire up monorepo` |
| 2 | Logger + env + Supabase | #7, #3, #4 | `feat(web): add logger, env validation, Supabase clients` |
| 3 | Sentry baseline | #5, #6 | `feat(web): add Sentry with PII scrubbing and instrumentation hook` |
| 4 | Landing + health | #8, #9 | `feat(web): add landing page and /api/health endpoint` |
| 5 | Finalize | #10, #11 | `chore(web): verify build and update README quick start` |

Squash-merge при закрытии PR (один финальный коммит по Conventional Commits, ≤ 72 символа в заголовке).

## Definition of Done

- `pnpm install && pnpm typecheck && pnpm lint && pnpm build` — все четыре команды проходят без ошибок из корня.
- `apps/web/lib/env.ts` валидирует server + client env через Zod; отсутствие обязательной переменной → `process.exit(1)` с читаемой ошибкой.
- `createBrowserClient`, `createServerClient`, `createAdminClient` реализованы; `createAdminClient` отмечен `import 'server-only'`.
- `Sentry.init` подключён через `instrumentation.ts` + `instrumentation-client.ts`; `beforeSend` редактирует PII-поля по денилисту.
- `logger` (pino) в `apps/web/lib/logger.ts` — default export, verbose в dev, redact для секретов.
- `/` отдаёт русскоязычный лендинг; `/api/health` отдаёт 200 с `{status:'ok'}`.
- README корня обновлён: шаг с `create-next-app` заменён; `docs/` **не трогали**.
- Границы пакетов не нарушены: `apps/web` импортирует только из `@oplati/*`, без cross-package приватных путей.

## Risks & открытые вопросы

1. **Build без env** — если `env.ts` парсит env на этапе импорта, `next build` упадёт без `.env.local`. Mitigation: lazy-getter в `env.ts` (см. task #10).
2. **Sentry + Next 16 ESM** — актуальные версии `@sentry/nextjs` совместимы с Next 16; если нет — пин на последнюю рабочую и отметить в ADR.
3. **`noUncheckedIndexedAccess` + create-next-app** — базовый template иногда использует `array[0]` без проверки. Если `tsc` упадёт — поправлять точечно.
4. **Eslint-конфликты** — create-next-app v15+ приносит flat config; проверить что не конфликтует с правилами корня (лишних правил в корне нет, так что должно быть чисто).
5. **`@supabase/ssr` API** — актуальный на 2026-04: `createBrowserClient` / `createServerClient` + cookie handlers. Если API поменялся — сверить с документацией supabase, не импровизировать.

## Next step

```
/aif-implement
```
