# Plan — Preview-деплой Vercel fra1 (end-to-end smoke /start → AI-ответ → запись в Supabase)

- **Branch (планируемая):** `feature/preview-deploy-vercel`
- **Created:** 2026-04-30
- **Plan author:** Claude Opus 4.7 (1M) через `/aif-plan full`
- **Base:** `main` (после merge `feature/db-base-schema` PR'ом — см. Pre-step ниже)

## Settings

- **Testing:** нет — smoke через Telegram + Supabase MCP. Vitest появится со Sprint 2 по CLAUDE.md; unit-тесты на repository-функции тащить раньше времени не будем.
- **Logging:** verbose. На уровне repository-функций — DEBUG (вход/выход + поднятые id'шники), INSERT новой строки — INFO (`db.user.created`, `db.conversation.created`, `db.message.persisted`). Все события — структурированные через `pino` `childLogger('db')`.
- **Docs update:** да — журнал, AGENTS.md, CLAUDE.md, CHANGELOG.md, `.ai-factory/ROADMAP.md`. Файлы в `docs/*` править НЕ нужно — они уже описывают финальное состояние; если расхождение — правится код, не docs (CLAUDE.md golden rule).

## Pre-step (до старта плана)

Текущая ветка `feature/db-base-schema` опережает `main` на 4 коммита (предыдущий milestone «Базовая схема БД» не залит). По выбору пользователя:

1. Создать PR `feature/db-base-schema` → `main`, провести review, **squash-merge** (по `docs/coding-standards.md`).
2. Локально:
   ```bash
   git checkout main
   git pull --ff-only origin main
   git checkout -b feature/preview-deploy-vercel
   ```
3. После создания ветки — старт Phase 1.

**Этот pre-step не входит в Tasks** — он принадлежит CI/PR-flow, не плану. План начинается с актуальной `main` + 4 коммита базовой схемы.

## Roadmap Linkage

- **Milestone:** «Preview-деплой (Vercel fra1)» (`.ai-factory/ROADMAP.md` строка 13).
- **Rationale:** план реализует ровно DoD этого milestone — end-to-end smoke `/start` → AI-ответ → запись в Supabase. Дополнительно закрывает технический долг по `preferredRegion='fra1'` + `maxDuration` в API routes (требование `docs/deployment.md` раздел «Регионы и функции»).
- **Sprint roadmap correspondence:** `docs/roadmap.md` Sprint 1 пункт «Деплой Vercel fra1; первый smoke».

## Контекст и решения

### Текущее состояние

- **Vercel-проект работает** (`oplati-podpisku-web` — Production: `https://oplati-podpisku-web.vercel.app`, Preview: branch-aliases). `vercel.json` отсутствует — конфиг через route-level exports. **Deployment Protection: Disabled** (зафиксировано в AGENTS.md/CLAUDE.md).
- **Два бота настроены** в Vercel env (Production / Preview): `@test_prodipsa_bot` / `@dev_test_podpiska_bot`. Раздельные `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET`.
- **`/api/bot/route.ts`** — grammY webhook, secret-token check, `runAgentNoTools` без записи в БД.
- **`packages/db`** содержит только `schema.ts` + `getDb()` (`src/index.ts`); repositories отсутствуют.
- **Supabase `nyxijwpuvctmvemaemqn`** — 4 таблицы (`users`, `staff`, `conversations`, `messages`), RLS включён, миграции 0000/0001/0002 применены.

### Решения по scope (зафиксированы)

1. **Что пишем в БД на этом milestone:**
   - `/start` → создаём/upsert'им `user` (по `telegram_id`), создаём/находим активный `conversation` (channel='telegram'), пишем 1 строку `messages(role='user', content='/start')` + 1 строку `messages(role='assistant', content=GREETING)`.
   - Текстовое сообщение → user → conversation → 2 строки в `messages`: user-msg (с `meta.telegram_message_id`, `meta.telegram_update_id`) и assistant-msg (с `meta.usage`).
2. **AI history НЕ берём из БД на этом milestone.** `runAgentNoTools` по-прежнему получает только текущее сообщение пользователя — поведение AI не меняется. БД ведёт **аудит-лог**, не контекстное окно. Загрузка истории — отдельный milestone «State machine + tools». Это явное решение, чтобы изолировать риск: если запись в БД ломается, AI продолжает отвечать (graceful degradation).
3. **Идемпотентность Telegram update_id — вне scope.** В `docs/database.md` идемпотентность формально только у `payments` через `UNIQUE(provider, provider_ref)`. Telegram-ретраи редкие; на этом milestone мы пишем `telegram_update_id` в `messages.meta` для последующего анализа, но UNIQUE-constraint не ставим. Полная идемпотентность — отдельный milestone (вместе с `orders`).
4. **`@oplati/db` импортируется напрямую из `apps/web`** (а не из `@oplati/agent`) — это правильно по `docs/architecture.md` («`agent` общается с БД только через ToolHandlers; apps/web — все @oplati/*»).
5. **Запись в БД — синхронная**, до возврата `200 OK` Telegram'у. Pooler-write через `DATABASE_URL` (порт 6543, `prepare=false`) занимает ~50-200ms. Если БД лежит — `Sentry.captureException` + 200 для Telegram (webhook идемпотентен на стороне TG: ретраи будут, но это лучше, чем потерять delivery). При полном отказе БД — пользователю всё равно отправится AI-ответ (write оборачиваем в try/catch с логом, но НЕ обрываем flow).
6. **`preferredRegion = 'fra1'` + `maxDuration` добавляем во все API routes.** По `docs/deployment.md` раздел «Регионы и функции». Сейчас они отсутствуют в `/api/bot/route.ts` и `/api/health/route.ts` — это технический долг, закрываем в этом milestone.

### Архитектура repository-слоя

```
packages/db/src/
├── index.ts                       # barrel: getDb + schema + repositories
├── schema.ts                       # без изменений
└── repositories/
    ├── index.ts                    # barrel re-export
    ├── users.ts                    # getOrCreateUserByTelegramId
    ├── conversations.ts            # getOrCreateActiveConversation
    └── messages.ts                 # appendMessage
```

**Контракт функций** (черновик, финальные сигнатуры — в Task'ах):
```ts
// users.ts
getOrCreateUserByTelegramId(input: {
  telegramId: string;
  displayName?: string | null;
  language?: string;        // default 'ru' уже на колонке
}): Promise<{ id: string; created: boolean }>;

// conversations.ts
getOrCreateActiveConversation(input: {
  userId: string;
  channel: 'telegram' | 'web';
}): Promise<{ id: string; created: boolean }>;

// messages.ts
appendMessage(input: {
  conversationId: string;
  role: 'user' | 'assistant' | 'operator' | 'system';
  content: string;
  staffId?: string | null;        // только для role='operator'
  meta?: Record<string, unknown> | null;
}): Promise<{ id: string }>;
```

**Стратегия upsert для `users`:** partial unique (`WHERE telegram_id IS NOT NULL`) поддерживается в Drizzle через `.onConflictDoUpdate({ target: users.telegramId, targetWhere: sql\`telegram_id IS NOT NULL\`, set: {...} })`. Если в текущей версии drizzle-orm нет targetWhere — используем raw SQL через `db.execute(sql\`INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING id\`)`. Проверка — в Task 1.

**Стратегия `getOrCreateActiveConversation`:** один conversation на (user_id, channel). Берём `SELECT ... ORDER BY created_at DESC LIMIT 1` — если есть, возвращаем. Если нет — INSERT. Для milestone достаточно — TTL/закрытие conversation добавим в milestone «Handoff оператору». Race-conditions в рамках одного пользователя через webhook маловероятны (TG queues по chat_id), но обернём в `select-then-insert` без транзакции — допустимо: дубликат conversation на этом milestone = одна лишняя строка в audit, не криminal.

### Smoke-стратегия (вместо unit-тестов)

End-to-end через preview-деплой:
1. Push в `feature/preview-deploy-vercel` → Vercel автособирает Preview.
2. Получить preview-URL (`vercel ls` или из PR-комментария).
3. `setWebhook` dev-бота на `<preview-url>/api/bot` с тем же secret-token, что в Vercel Preview env.
4. В TG отправить `/start` + текстовое сообщение `@dev_test_podpiska_bot`.
5. Через Supabase MCP `execute_sql`:
   - `SELECT id, telegram_id, display_name FROM users ORDER BY created_at DESC LIMIT 5;`
   - `SELECT * FROM conversations WHERE user_id = '<id>';`
   - `SELECT role, content, meta FROM messages WHERE conversation_id = '<id>' ORDER BY created_at;`
6. Зафиксировать результат в `.ai-factory/Journal/preview-deploy-vercel.md`.

## Tasks

### Phase 1 — Repository-функции (`@oplati/db`)

#### Task 1: Создать `getOrCreateUserByTelegramId`
- **Файл (новый):** `packages/db/src/repositories/users.ts`
- **Сигнатура:** `getOrCreateUserByTelegramId(db: DB, input: { telegramId: string; displayName?: string | null; language?: string }): Promise<{ id: string; created: boolean }>`
  - Принимаем `db` явно как параметр (а не глобальный `getDb()`) — упрощает мокать в будущих тестах и не привязывается к процесс-singleton'у.
- **Поведение:**
  - `INSERT INTO users (telegram_id, display_name, language) VALUES (...) ON CONFLICT (telegram_id) WHERE telegram_id IS NOT NULL DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, users.display_name), updated_at = now() RETURNING id, (xmax = 0) AS created`.
  - Если drizzle-orm не поддерживает partial-unique target — fallback на `db.execute(sql\`...\`)` с тем же запросом.
- **Edge case:** `displayName` может быть `null` (Telegram from может не иметь `first_name`). Не перезаписываем существующее значение `null`'ом.
- **Логирование (verbose):**
  - DEBUG `db.users.upsert.start` (telegramId — захэшировать через `crypto.createHash('sha256').update(telegramId).digest('hex').slice(0, 8)` ради PII; raw telegramId в логе запрещён по `docs/security.md`).
  - INFO `db.users.created` `{ userIdHash, created: true }` — только если created=true.
  - DEBUG `db.users.upsert.done` `{ userIdHash, created, durationMs }`.
- **Зависимости:** ничего; первая в Phase.

#### Task 2: Создать `getOrCreateActiveConversation`
- **Файл (новый):** `packages/db/src/repositories/conversations.ts`
- **Сигнатура:** `getOrCreateActiveConversation(db: DB, input: { userId: string; channel: 'telegram' | 'web' }): Promise<{ id: string; created: boolean }>`
- **Поведение:**
  - `SELECT id FROM conversations WHERE user_id = $1 AND channel = $2 ORDER BY created_at DESC LIMIT 1` — если есть → return `{ id, created: false }`.
  - Иначе `INSERT INTO conversations (user_id, channel) VALUES (...) RETURNING id` → `{ id, created: true }`. (handoff_mode по умолчанию `ai`, FK `staff` остаётся NULL.)
- **Race-conditions:** допускаем дубликат при concurrent inserts; на этом milestone не критично (см. «Решения», п.2 в архитектуре). Если позже понадобится — добавим partial-unique индекс в milestone «Handoff оператору».
- **Логирование (verbose):**
  - DEBUG `db.conversations.lookup` `{ userId, channel }`.
  - INFO `db.conversations.created` `{ conversationId, userId, channel }` — если created=true.
  - DEBUG `db.conversations.resumed` `{ conversationId, userId, channel }` — если created=false.
- **Зависимости:** Task 1 не блокирует строго (parallel), но логически после.

#### Task 3: Создать `appendMessage`
- **Файл (новый):** `packages/db/src/repositories/messages.ts`
- **Сигнатура:** `appendMessage(db: DB, input: { conversationId: string; role: 'user'|'assistant'|'operator'|'system'; content: string; staffId?: string | null; meta?: Record<string, unknown> | null }): Promise<{ id: string }>`
- **Поведение:** простой `INSERT INTO messages (...) RETURNING id`.
- **Валидация на границе:** `role='operator'` без `staffId` — TS-уровень: на уровне функции допустим, но логируем WARN. Это инвариант `docs/database.md` («staff_id required when role=operator»), но в БД nullable — будем форсить через Zod-схему позже в milestone «Handoff оператору».
- **Логирование (verbose):**
  - INFO `db.messages.persisted` `{ messageId, conversationId, role, contentLength, hasMeta }` — без `content` в логе (PII).
- **Зависимости:** Task 2 (нужен `conversationId`).

#### Task 4: Barrel re-exports + DB-singleton-helpers
- **Файлы:**
  - **Новый:** `packages/db/src/repositories/index.ts` — re-export всех трёх функций.
  - **Правка:** `packages/db/src/index.ts` — добавить `export * from './repositories/index.ts'`.
- **Проверка:** `pnpm --filter @oplati/db typecheck` — зелёный. Импорт `import { getOrCreateUserByTelegramId } from '@oplati/db'` — работает.
- **Логирование:** N/A (barrel).
- **Зависимости:** Tasks 1-3.

### Phase 2 — Vercel runtime-конфиг

#### Task 5: Добавить `preferredRegion='fra1'` + `maxDuration` в API routes
- **Файлы:**
  - `apps/web/app/api/bot/route.ts` — добавить `export const preferredRegion = 'fra1'; export const maxDuration = 30;`
  - `apps/web/app/api/health/route.ts` — добавить `export const preferredRegion = 'fra1'; export const maxDuration = 5;`
- **Зачем:** `docs/deployment.md` явно требует `fra1`; без этого Vercel может разместить функцию в любом регионе, что увеличит latency до Supabase EU и Anthropic.
- **`maxDuration`:** для `/api/bot` 30s (Telegram даёт 60s, но 30 достаточно — webhook делает 1 Anthropic-call + 3-4 БД-запроса); для `/api/health` 5s (heartbeat).
- **Логирование:** N/A (декларации).
- **Зависимости:** ни от чего.

### Phase 3 — Интеграция в webhook

#### Task 6: Записывать диалог в БД в `handle-update.ts`
- **Файл:** `apps/web/lib/telegram/handle-update.ts`
- **Изменения:**
  - Импортировать `getDb`, `getOrCreateUserByTelegramId`, `getOrCreateActiveConversation`, `appendMessage` из `@oplati/db`.
  - Добавить хелпер `persistInbound(message: TelegramMessage): Promise<{ userId: string; conversationId: string } | null>`:
    - Если `message.from?.id` отсутствует — return null + log WARN.
    - `getOrCreateUserByTelegramId({ telegramId: String(message.from.id), displayName: [first_name, last_name].filter(Boolean).join(' ') || null, language: message.from.language_code ?? 'ru' })`.
    - `getOrCreateActiveConversation({ userId, channel: 'telegram' })`.
    - return `{ userId, conversationId }`.
    - Все ошибки оборачиваем в try/catch — логируем `db.persistInbound.failed` + `Sentry.captureException` + return null. **Не пробрасываем** — webhook не должен ломаться из-за БД.
  - В ветке `/start`:
    - `const ctx = await persistInbound(message)`.
    - Если `ctx`: `appendMessage(role='user', content='/start', meta={ telegram_update_id, telegram_message_id })` затем `appendMessage(role='assistant', content=GREETING, meta={ source: 'static_greeting' })`.
    - `await sendSafely(chatId, GREETING, update.update_id)` — **после** записи (но не блокируя при ошибке БД).
  - В ветке текстового сообщения:
    - `const ctx = await persistInbound(message)`.
    - Если `ctx`: `appendMessage(role='user', content=text, meta={ telegram_update_id, telegram_message_id })` **до** AI-call.
    - `runAgentNoTools(...)` — поведение не меняется (history НЕ загружаем из БД на этом milestone).
    - Если `ctx` && reply непустой: `appendMessage(role='assistant', content=replyText, meta={ telegram_update_id, usage: { input_tokens, output_tokens }, finish_reason })`.
    - Отправка в TG — как и раньше, с разбиением `splitForTelegram`.
- **Логирование (verbose):**
  - INFO `telegram.persist.start` (updateId, chatId).
  - INFO `telegram.persist.done` `{ updateId, userIdHash, conversationId, durationMs }`.
  - WARN `telegram.persist.skipped` `{ updateId, reason: 'no_from_id'|'db_error' }`.
- **Поведение при недоступной БД:** `persistInbound` возвращает null → continue без записи; AI-ответ всё равно уходит. Sentry поймает ошибку. Это **graceful degradation**: бот не молчит при падении Postgres.
- **Зависимости:** Tasks 1-4.

### Phase 4 — Smoke и closeout

#### Task 7: Подготовить runbook для smoke-теста
- **Файл (новый):** `.ai-factory/Journal/preview-deploy-vercel.md` (создать пустой шаблон с разделами «Cmd», «Ожидание», «Результат» — заполнится в Task 8).
- **Содержимое шаблона:**
  - Шаг 1: push в feature-ветку, ссылка на preview-URL из PR-комментария.
  - Шаг 2: `setWebhook` dev-бота (точная команда из `docs/deployment.md` «Telegram webhook — preview», но с актуальным `<preview-url>`).
  - Шаг 3: TG-команды `/start` и текстовое сообщение.
  - Шаг 4: SQL-запросы через Supabase MCP `execute_sql` (`project_id=nyxijwpuvctmvemaemqn`):
    - `SELECT id, telegram_id, display_name, created_at FROM users ORDER BY created_at DESC LIMIT 5;`
    - `SELECT id, user_id, channel, handoff_mode, created_at FROM conversations ORDER BY created_at DESC LIMIT 5;`
    - `SELECT role, content, meta, created_at FROM messages WHERE conversation_id = '<id>' ORDER BY created_at;`
- **Логирование:** N/A (документ).
- **Зависимости:** Tasks 5-6 (нужен задеплоенный код).

#### Task 8: Выполнить end-to-end smoke
- **Шаги:**
  1. Запушить ветку → дождаться Vercel preview build.
  2. Перерегистрировать webhook dev-бота (через `curl` из `docs/deployment.md`).
  3. Открыть `@dev_test_podpiska_bot`, отправить `/start`. Ожидание: получить `GREETING`. Зафиксировать `update_id`.
  4. Отправить текстовое сообщение «Привет, нужна подписка Claude». Ожидание: AI-ответ. Зафиксировать `update_id`.
  5. Через Supabase MCP — все три SELECT'а. Скопировать output в Journal.
  6. **Verify-criteria** (всё должно быть `true`):
     - В `users` есть строка с `telegram_id = '<твой-tg-id>'`, `display_name` непустой.
     - В `conversations` ровно 1 строка для этого `user_id`, `channel='telegram'`, `handoff_mode='ai'`.
     - В `messages` для этого `conversation_id` — 4 строки в порядке: user `/start`, assistant GREETING, user `Привет...`, assistant AI-reply.
     - У assistant-сообщений в `meta` есть `usage.input_tokens` / `usage.output_tokens`.
     - У user-сообщений в `meta` есть `telegram_update_id` и `telegram_message_id`.
  7. **Negative-check:** удалить из БД `users` запись (CASCADE снесёт conversations/messages), отправить `/start` снова — должна создаться новая запись (не та же).
  8. Зафиксировать всё в `.ai-factory/Journal/preview-deploy-vercel.md` — sql-output, скриншоты Vercel логов с `telegram.persist.done`, метрики latency.
- **Логирование:** smoke генерит логи через verbose-уровень на dev-боте — все события `db.users.created`, `db.conversations.created`, `db.messages.persisted` должны быть видны в Vercel Logs.
- **Зависимости:** Task 7.

#### Task 9: Прогнать `pnpm typecheck && pnpm lint && pnpm build`
- **Команды:** последовательно из корня:
  ```bash
  pnpm typecheck
  pnpm lint
  pnpm build
  ```
- **Ожидание:** все три зелёные. Если eslint ругается на новый код в `repositories/` — править, не отключать правила.
- **Зависимости:** Tasks 1-6.

#### Task 10: Обновить документацию + закрыть milestone
- **Файлы:**
  - **`.ai-factory/ROADMAP.md`:** строка 13 `- [ ]` → `- [x]`; в Completed добавить `| Preview-деплой (Vercel fra1) | 2026-04-30 |`.
  - **`AGENTS.md`** — обновить секцию «Key Entry Points»:
    - Добавить `packages/db/src/repositories/{users,conversations,messages}.ts` — `Repository functions for users / conversations / messages`.
    - В «Статус» добавить: «Repository-функции реализованы; webhook пишет user/conversation/messages в Supabase».
  - **`CLAUDE.md`** — раздел «Статус репо» (около строки 56):
    - Добавить пункт «Repository-функции (`getOrCreateUserByTelegramId`, `getOrCreateActiveConversation`, `appendMessage`) и end-to-end запись из `/api/bot` в Supabase».
    - Сменить «Следующий milestone» на «Расширение схемы БД» (services / orders / payments / attachments / order_events + seed каталога).
  - **`CHANGELOG.md`:**
    - Под секцией «Unreleased» добавить запись:
      - `### Added — feat(db): repository functions (users/conversations/messages); fra1 region pinned for /api/bot and /api/health; webhook persists Telegram dialog into Supabase as audit log.`
- **Зависимости:** Task 8 (нельзя помечать milestone закрытым до успешного smoke).

## Commit Plan

10 задач — нужны checkpoints. По 2-3 задачи в коммит:

| # | После задач | Сообщение |
|---|---|---|
| 1 | 1 + 2 + 3 + 4 | `feat(db): add repositories for users/conversations/messages` |
| 2 | 5 | `chore(web): pin /api/bot and /api/health to fra1 region` |
| 3 | 6 | `feat(web): persist Telegram dialog into Supabase via /api/bot` |
| 4 | 7 + 8 | `docs(qa): preview-deploy smoke runbook + journal` |
| 5 | 9 + 10 | `chore: close milestone "Preview-деплой Vercel fra1"` |

Conventional Commits, ≤72 символа в заголовке (`docs/coding-standards.md`).

## Definition of Done (этот milestone)

- [x] `packages/db/src/repositories/{users,conversations,messages}.ts` существуют, экспортируются из `@oplati/db`.
- [x] `apps/web/app/api/bot/route.ts` и `apps/web/app/api/health/route.ts` имеют `preferredRegion='fra1'` и `maxDuration`.
- [x] `apps/web/lib/telegram/handle-update.ts` пишет user/conversation/messages при `/start` и при текстовых сообщениях; ошибки БД не ломают webhook (graceful degradation).
- [ ] End-to-end smoke на preview-деплое выполнен: `/start` + текстовое сообщение dev-боту → 4 строки в `messages`, 1 в `conversations`, 1 в `users`. Журнал заполнен в `.ai-factory/Journal/preview-deploy-vercel.md`.
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm build` зелёные.
- [ ] `.ai-factory/ROADMAP.md`: `[x] Preview-деплой (Vercel fra1)` + строка в Completed.
- [ ] AGENTS.md / CLAUDE.md / CHANGELOG.md обновлены.

## Что НЕ входит в этот план

- **Загрузка истории диалога из БД** в AI-context (`runAgent` будет получать только текущее сообщение). Это milestone «State machine + AI tools» — там же появится `runAgent` с tools и contextual memory.
- **Идемпотентность Telegram update_id через UNIQUE-constraint.** Полная идемпотентность — milestone «Расширение схемы БД» (`payments(provider, provider_ref)`) и далее. Сейчас `telegram_update_id` пишется в `meta`, но без unique.
- **Web-channel запись.** Только Telegram. Web-чат и его `/api/chat` — milestone «Веб-чат `/chat`».
- **`runAgent` с tools** — отложено на milestone «State machine + AI tools».
- **Custom-домен** для production. Сейчас работает default Vercel-домен.
- **Sentry-алерты на failed-persist.** Базовый `captureException` есть, но дашборды/алерты — milestone «Production-ready».
- **Realtime-обновления админки на новый message.** Будет в milestone «Realtime в админке».
- **`updated_at` триггеры в БД.** Drizzle обновляет руками в коде; Postgres-триггер — отложен.

## Риски и mitigation

| Риск | Mitigation |
|---|---|
| `prepare=false` + ON CONFLICT через partial unique — Drizzle/postgres-js может не поддержать targetWhere | Fallback на `db.execute(sql\`...\`)` с raw SQL; проверить в Task 1 первой строкой кода |
| Запись в БД увеличит latency webhook'а ≥30s в worst case | `maxDuration=30`, измеряем `durationMs` в логах; если p95 > 5s — переходим на background-write через Trigger.dev |
| Race-conditions при concurrent webhook (один user шлёт 2 сообщения подряд) → дубликат conversations | Допустимо на этом milestone; partial-unique индекс — milestone «Handoff» |
| Preview-деплой ломает prod-бота (если webhook прописан не на тот URL) | Раздельные TG-боты — `@dev_test_podpiska_bot` для preview, `@test_prodipsa_bot` для prod (уже настроено) |
| RLS заблокирует write — `service_role` обходит RLS, но `apps/web` использует service_role только в `lib/supabase/admin.ts`. Drizzle подключается через `DATABASE_URL` (postgres-js) — это идёт от роли `postgres`/owner, а не Supabase Auth | Drizzle через `postgres-js` идёт под service-уровнем pooler-юзера → RLS не применяется. Подтвердить в Task 1 (тестовый INSERT через `getOrCreateUserByTelegramId` должен пройти) |
