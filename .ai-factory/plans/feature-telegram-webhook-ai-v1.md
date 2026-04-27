# Telegram webhook + AI v1

**Branch:** `feature/telegram-webhook-ai-v1`
**Created:** 2026-04-27
**Type:** feature

## Overview

Реализовать `POST /api/bot` (Telegram webhook на grammY) и подключить Claude через `@oplati/agent` БЕЗ tools. Системный промпт консультанта (`SYSTEM_PROMPT`) и `GREETING` уже в `packages/agent/src/prompts.ts` — здесь мы их используем.

Спринт 1, milestone «Telegram webhook + AI v1» (`.ai-factory/ROADMAP.md`). После него: схема БД (`users`, `conversations`, `messages`) — там же будет история диалога.

## Settings

- **Testing:** no — Vitest пока не установлен в monorepo, Sprint 1 DoD не требует unit-тестов; верификация через ручной smoke (ngrok + dev-бот).
- **Logging:** verbose (debug) — `childLogger('telegram-bot')` поверх `apps/web/lib/logger.ts`. PII-redact уже настроен (тексты сообщений в логи не попадают; в `body.text`, `*.email`, `headers["x-telegram-bot-api-secret-token"]` — `[REDACTED]`).
- **Docs:** обновить `AGENTS.md` (снять метку «будет создан» с `/api/bot`), добавить запись в `.ai-factory/Journal/`, дополнить `CHANGELOG.md`.

## Roadmap Linkage

- **Milestone:** `none`
- **Rationale:** Skipped by user (фактически работа закрывает milestone «Telegram webhook + AI v1» из `.ai-factory/ROADMAP.md`, но формальная привязка пропущена; `/aif-verify` это отметит как WARN, не fail).

## Architecture decisions (для этого тикета)

1. **Stateless** — каждый Telegram update обрабатывается как одиночный `user → assistant` round-trip. Никакой in-memory истории (она потерялась бы на cold-start serverless и ввела бы дубль с будущей БД).
2. **Новая функция `runAgentNoTools()`** в `@oplati/agent` — отдельная от существующего `runAgent()`. Чище, чем условные ветки внутри одной функции; `runAgent()` остаётся нетронутой для Sprint 2 (когда появятся ToolHandlers).
3. **Node runtime, не Edge** — pino требует Node API, поэтому в route.ts: `export const runtime = 'nodejs'`.
4. **grammY как HTTP-клиент** — используем только `bot.api.sendMessage`; диспатч updates руками (no `bot.command`, no `bot.on`). На webhook-mode полноценный grammY-роутинг даёт overhead и слабую читаемость для нашего узкого набора кейсов.
5. **Webhook всегда `200 OK`** (кроме невалидного secret-token → `401`) — по требованию docs/telegram-integration.md и docs/api.md. Иначе Telegram ретраит и забивает очередь.
6. **`@oplati/types` без grammY-зависимости** — только `zod`. Минимальный `telegramUpdateSchema` (узкий slice — `update_id`, `message.chat.id`, `message.from.id`, `message.text`).

## Tasks

### Phase 1 — Зависимости и agent (можно параллельно)

#### Task 1: Добавить grammY в apps/web ✅

- [x] `pnpm --filter web add grammy` (версия `^1.42.0`)
- [x] Проверить, что `apps/web/package.json` зафиксировал версию.
- [x] В `apps/web/lib/logger.ts` (если потребуется) добавить пример `childLogger('telegram-bot')` — но скорее всего достаточно вызова в самом route.
- **Logs:** —
- **Files:** `apps/web/package.json`, `pnpm-lock.yaml`

#### Task 2: Расширить `@oplati/agent` — `runAgentNoTools()` ✅

- В `packages/agent/src/index.ts` экспортировать новую функцию:
  ```ts
  export async function runAgentNoTools(
    history: AgentMessage[],
  ): Promise<{ text: string; usage: Anthropic.Usage }>
  ```
- Внутри: тот же `getClient()`, `client.messages.create({ model, system: SYSTEM_PROMPT, max_tokens: 1024, messages, /* НЕТ tools */ })`. Один round-trip, никаких ToolHandlers, никакого цикла.
- `model = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-6'` (как в `runAgent`).
- **Logs:** не внутри agent-пакета (он — библиотека, без зависимостей от pino). Логирование на стороне route.
- **Files:** `packages/agent/src/index.ts`
- **Зависимости:** —

#### Task 3: Env-проверка для Telegram webhook ✅

- Схема в `apps/web/lib/env.ts` остаётся как есть (Telegram/Anthropic ключи `optionalEnvString()` — это правильно для build-time CI без секретов).
- В `/api/bot/route.ts` (Task 4) первым делом проверять наличие `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`. Если хоть одного нет → `200 OK` с `{ ok: false, error: 'not_configured' }` + `logger.warn` (Telegram не должен ретраить).
- **Logs:** `warn 'telegram.bot.disabled' { missing: ['TELEGRAM_BOT_TOKEN', ...] }`
- **Files:** `apps/web/app/api/bot/route.ts` (или вынесенный helper)
- **Зависимости:** —

#### Task 5: `telegramUpdateSchema` в `@oplati/types` ✅

- Новый файл `packages/types/src/telegram.ts`, реэкспорт из `src/index.ts`.
- Минимальный slice: `update_id`, `message?.{ message_id, chat.{ id, type }, from?.{ id, language_code, first_name, last_name? }, text? }`. `callback_query`, `edited_message` — пропустить (Sprint 2).
- Только `zod`, никаких grammY-импортов.
- **Logs:** —
- **Files:** `packages/types/src/telegram.ts`, `packages/types/src/index.ts`
- **Зависимости:** —

### Phase 2 — Webhook handler

#### Task 6: `apps/web/lib/telegram/bot.ts` — grammY Bot singleton ✅

- Lazy-init: `let _bot: Bot | undefined; function getBot() { ... }`
- Использовать `serverEnv.TELEGRAM_BOT_TOKEN`. Если его нет — throw (вызывающий код сам решает, что делать; в Task 4 проверка идёт раньше).
- Webhook-mode: НЕ вызываем `bot.start()` или `bot.run()`. Используем только `bot.api.sendMessage`.
- **Logs:** debug `'telegram.bot.initialized'` при первом инстансе.
- **Files:** `apps/web/lib/telegram/bot.ts`
- **Зависимости:** Task 1.

#### Task 4: `apps/web/app/api/bot/route.ts` — POST handler ✅

Структура:
- `route.ts` — HTTP-обвязка: runtime, secret-token check, парсинг body, вызов `handleTelegramUpdate`, ответ `200 OK`.
- `apps/web/lib/telegram/handle-update.ts` — диспатч (`/start` vs обычное сообщение vs игнор), вызов `runAgentNoTools`, отправка через `bot.api.sendMessage`. Чисто для читаемости (тестируемость подождёт).

Шаги:
1. `export const runtime = 'nodejs'`
2. POST(req):
   - Проверить `req.headers.get('x-telegram-bot-api-secret-token') === serverEnv.TELEGRAM_WEBHOOK_SECRET`. Несовпадение → `401`. Это **единственный** не-200 кейс.
   - Проверить env (Task 3) → если не настроено, `200 OK` + warn.
   - `const raw = await req.json()`. Если не JSON → лог error + Sentry, всё равно `200 OK`.
   - `const parsed = telegramUpdateSchema.safeParse(raw)`. Не прошло → лог warn `'telegram.update.invalid'` + `200 OK`.
   - `await handleTelegramUpdate(parsed.data)`.
   - `return new Response(JSON.stringify({ ok: true }), { status: 200 })`.
   - В try/catch вокруг handler: `logger.error` + `Sentry.captureException`, всё равно `200 OK`.
3. `handleTelegramUpdate(update)`:
   - Если `update.message?.text === '/start'` или `update.message.text.startsWith('/start ')` → `bot.api.sendMessage(chat.id, GREETING)`.
   - Иначе если `update.message?.text` (любой текст) → `runAgentNoTools([{ role: 'user', content: text }])` → `bot.api.sendMessage(chat.id, result.text)`. Если `result.text.length > 4096` — резать и слать кусками.
   - Иначе (нет `message.text`, callback и т. п.) → лог `'telegram.update.ignored' { kind }` и return.

**Logs (verbose, debug):**
- `'telegram.webhook.received'` `{ updateId, kind }` (kind = `start | message | ignored`; БЕЗ текста)
- `'telegram.start'` `{ chatId, telegramUserId, languageCode }`
- `'telegram.message.user'` `{ chatId, telegramUserId, textLength }` (БЕЗ текста)
- `'telegram.message.ai_reply'` `{ chatId, durationMs, totalTokens, replyLength }`
- `'telegram.update.ignored'` (warn) `{ kind }`
- ошибки → `logger.error({ err })` + `Sentry.captureException(err)`

**Files:**
- `apps/web/app/api/bot/route.ts`
- `apps/web/lib/telegram/handle-update.ts`

**Зависимости:** Task 1, 2, 3, 5, 6.

### Phase 3 — Верификация и документация

#### Task 7: Локальный smoke-test (ssh-туннель serveo + dev-бот) ✅

Это manual-проверка перед merge, не код:
1. Dev-бот через @BotFather (если ещё нет), `TELEGRAM_BOT_TOKEN` в `apps/web/.env.local` (dev-токен, не prod).
2. `TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)`.
3. `pnpm --filter web dev` + `ngrok http 3000`.
4. `curl -F "url=$NGROK_URL/api/bot" -F "secret_token=$SECRET" -F "drop_pending_updates=true" -F 'allowed_updates=["message"]' https://api.telegram.org/bot$TOKEN/setWebhook`
5. Проверить: `/start` → `GREETING`; «Хочу Claude Pro» → AI отвечает (без вызова tools, потому что их и не передаём); неверный secret-token → 401 в логах ngrok; `getWebhookInfo` → `pending_update_count: 0`, `last_error_message: ""`.

**DoD:** запись в Journal об успешном прогоне (и о том, что наблюдалось в логах: durationMs, totalTokens).

**Зависимости:** Task 4.

#### Task 8: AGENTS.md, Journal, CHANGELOG ✅

- `AGENTS.md`: убрать «будет создан» рядом с `apps/web/app/api/bot/route.ts`; обновить блок «Статус» — упомянуть Telegram webhook + AI v1 как реализованный.
- `.ai-factory/Journal/2026-04-27-telegram-webhook-ai-v1.md`: 5–10 строк о решениях (stateless, runAgentNoTools, Node runtime, parse_mode=plain).
- `CHANGELOG.md`: `feat(web): Telegram webhook /api/bot + AI v1 (Claude без tools, stateless)`.
- Ничего НЕ помечать в `.ai-factory/ROADMAP.md` — это работа `/aif-verify`.

**Зависимости:** Task 4.

## Commit Plan

Целевая стратегия: один squash-merge на PR, заголовок ≤ 72 символа.

Внутри ветки разбить на 3 чекпоинта (по фазам), чтобы было удобно делать `git revert` отдельных шагов до merge:

1. **`feat(types,agent): add telegramUpdateSchema and runAgentNoTools`** — после Task 2 + Task 5.
2. **`feat(web): Telegram webhook /api/bot with grammY + Claude (no tools)`** — после Task 1, 3, 4, 6 (основной функциональный коммит).
3. **`docs: update AGENTS.md, Journal, CHANGELOG for Telegram webhook v1`** — после Task 7 (manual smoke прошёл) + Task 8.

PR title: `feat(web): Telegram webhook + AI v1 (Claude без tools)`.

## Open questions / risks

- **`@anthropic-ai/sdk` версия 0.32** в `packages/agent/package.json` — проверить, что API `client.messages.create({ system, messages, max_tokens })` без `tools`-поля работает на текущей версии. Beta-флаги для tools не нужны, это нативная поддержка с весны 2024.
- **Длинные ответы AI > 4096** — Telegram режет. Решение: split на части по `\n` границам, отправлять последовательно. Если сегмент всё равно > 4096 — режем посимвольно.
- **403 при заблокированном пользователем боте** — на этом этапе игнорируем (просто лог warn). Полная обработка `users.notes = 'blocked_bot'` — после появления БД.
- **Rate limit Telegram (1 msg/sec в чат)** — на 50 заказов/день нерелевантно; обработка retries/throttling — Sprint 3.
