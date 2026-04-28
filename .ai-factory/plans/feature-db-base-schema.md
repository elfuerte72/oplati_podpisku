# Plan — Базовая схема БД (`users`, `staff`, `conversations`, `messages`)

- **Branch:** `feature/db-base-schema`
- **Created:** 2026-04-27
- **Plan author:** Claude Opus 4.7 (через `/aif-plan full`)

## Settings

- **Testing:** нет (инфра-milestone — schema + миграция; Vitest появится со Sprint 2 по CLAUDE.md).
- **Logging:** N/A на уровне приложения (нет нового runtime-кода). На уровне инструментов — `drizzle-kit verbose=true` (уже включено в `drizzle.config.ts`) даёт SQL в stdout; Supabase MCP-вызовы возвращают результат в transcript.
- **Docs update:** не требуется — `docs/database.md` уже описывает финальную схему. Расхождений после имплементации не должно быть; если появятся — исправить код, не docs (CLAUDE.md golden rule).

## Roadmap Linkage

- **Milestone:** «Базовая схема БД» (`.ai-factory/ROADMAP.md` строка 12).
- **Rationale:** план реализует ровно DoD этого milestone — `users`, `conversations`, `messages` в Drizzle, миграция применена через `db:push`. Дополнительно держим `staff` как FK target (без него `conversations.assigned_operator_id` и `messages.staff_id` нельзя сохранить с FK по `docs/database.md`).
- **Sprint roadmap correspondence:** `docs/roadmap.md` Sprint 1 пункт «Supabase проект, Drizzle миграции: users, conversations, messages».

## Контекст и решения

### Текущее состояние

- `packages/db/src/schema.ts` — содержит **полную** схему всех 9 таблиц (создано на bootstrap'е).
- `packages/db/migrations/` — отсутствует (миграций не было).
- Supabase project `nyxijwpuvctmvemaemqn` — public schema **пустая**, `pgcrypto` уже установлен.
- `apps/web/.env.local` — `DATABASE_URL` и `DATABASE_URL_DIRECT` заполнены.
- `drizzle.config.ts` — настроен на `out: './migrations'`, использует `DATABASE_URL_DIRECT ?? DATABASE_URL`.

### Решения по scope (согласовано с владельцем)

1. **Применяем 4 таблицы:** `users`, `staff`, `conversations`, `messages` + 4 enum'а: `user_channel`, `staff_role`, `handoff_mode`, `message_role`. Услуги/заказы/платежи откладываются на milestone «Расширение схемы БД».
2. **`staff` входит в первую миграцию** как FK target — без неё `conversations.assigned_operator_id → staff.id` и `messages.staff_id → staff.id` сломали бы миграцию (FK на несуществующую таблицу). Сама `staff` пока пустая — наполнение в milestone «Минимальная админка».
3. **RLS:** только `ENABLE ROW LEVEL SECURITY`, без политик. `service_role` обходит RLS — server-only код продолжит работать. Политики приедут со Sprint 2 (роли operator/supervisor/admin + Supabase Auth).
4. **Тесты:** не пишем. Milestone — чистая инфра. Smoke-проверка через Supabase MCP (`list_tables`, `execute_sql`).

### Расхождения schema.ts ↔ docs/database.md, которые правим в этом milestone

| Что | В schema.ts сейчас | По docs/database.md | План |
|---|---|---|---|
| `users.telegram_id` unique | полный `uniqueIndex` | partial `UNIQUE WHERE NOT NULL` | переписать на `.where(sql\`telegram_id IS NOT NULL\`)` |
| `users.web_session_id` unique | полный `uniqueIndex` | partial `UNIQUE WHERE NOT NULL` | переписать аналогично |
| CHECK «хотя бы один identity» | отсутствует | `CHECK (telegram_id IS NOT NULL OR web_session_id IS NOT NULL)` | добавить через `check()` |

Остальное в schema.ts корректно: типы, FK ON DELETE, indexes, default'ы.

### Поток применения миграций

Drizzle-kit `db:push` сравнивает `schema.ts` с реальной БД и применяет diff — он **не запускает** содержимое .sql файлов автоматически. Поэтому:

1. **DDL для таблиц/enum/индексов** — `db:generate` создаёт .sql (audit trail) → `db:push` применяет diff из schema.ts.
2. **RLS** — это raw SQL, Drizzle в schema.ts его не выражает. Решение: кастомная миграция `0001_enable_rls.sql` (через `drizzle-kit generate --custom`) → применить через **Supabase MCP `apply_migration`** (записывается в `supabase_migrations.schema_migrations` — audit trail на стороне Supabase).

Это укладывается в CLAUDE.md golden rule «миграции через Drizzle, не через Dashboard кликами»: SQL-файл коммитится в репо, применяется через CLI/MCP, а не через UI.

## Tasks

### Phase 1 — Schema corrections

#### Task 1: Сузить `schema.ts` до 4 таблиц
- **Файл:** `packages/db/src/schema.ts`
- **Удалить:** enums `order_status`, `payment_provider`, `payment_status`, `attachment_kind`, `actor_type`; таблицы `services`, `orders`, `orderEvents`, `payments`, `attachments`.
- **Оставить:** enums `user_channel`, `staff_role`, `handoff_mode`, `message_role`; таблицы `users`, `staff`, `conversations`, `messages`.
- **Проверить imports** в `packages/db/src/index.ts` — barrel re-export через `export * from './schema.ts'` не требует правок.
- **Логирование:** N/A.

#### Task 2: Привести `users` к `docs/database.md`
- **Файл:** `packages/db/src/schema.ts`
- **Изменения:**
  ```ts
  // partial unique через drizzle .where()
  telegramIdx: uniqueIndex('users_telegram_id_idx')
    .on(t.telegramId)
    .where(sql`${t.telegramId} IS NOT NULL`),
  webSessionIdx: uniqueIndex('users_web_session_id_idx')
    .on(t.webSessionId)
    .where(sql`${t.webSessionId} IS NOT NULL`),
  // + CHECK constraint
  identityCheck: check(
    'users_identity_present',
    sql`${t.telegramId} IS NOT NULL OR ${t.webSessionId} IS NOT NULL`,
  ),
  ```
- **Импорты:** добавить `check`, `sql` из `drizzle-orm` / `drizzle-orm/pg-core`.
- **Логирование:** N/A.

### Phase 2 — Migration generation

#### Task 3: Сгенерировать первую миграцию
- **Команда:** `pnpm --filter @oplati/db db:generate`
- **Ожидание:** `packages/db/migrations/0000_<name>.sql` + `packages/db/migrations/meta/_journal.json`.
- **Verify в SQL вручную:**
  - `CREATE TYPE public.user_channel AS ENUM ('telegram','web');` и аналогично для staff_role, handoff_mode, message_role
  - `CREATE TABLE users (...) WITH CHECK (telegram_id IS NOT NULL OR web_session_id IS NOT NULL)` (или отдельный ALTER ADD CONSTRAINT — оба варианта приемлемы)
  - `CREATE UNIQUE INDEX users_telegram_id_idx ON users (telegram_id) WHERE telegram_id IS NOT NULL;`
  - FK `conversations.assigned_operator_id REFERENCES staff(id)` и `messages.staff_id REFERENCES staff(id)` присутствуют
- **Логирование:** drizzle-kit `verbose=true` уже в drizzle.config.ts — увидим SQL в stdout.

### Phase 3 — RLS

#### Task 4: Добавить кастомную миграцию `enable_rls`
- **Команда:** `pnpm --filter @oplati/db exec drizzle-kit generate --custom --name=enable_rls`
- **Файл:** `packages/db/migrations/0001_enable_rls.sql` (заполнить руками)
- **Содержимое:**
  ```sql
  -- ENABLE RLS для всех 4 таблиц с пользовательскими данными.
  -- Политики (operator/supervisor/admin) добавятся в milestone «Минимальная админка»
  -- (Sprint 2). Пока service_role обходит RLS — server-only код работает.
  ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "staff" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
  ```
- **Логирование:** SQL коммитится в git как audit trail.

### Phase 4 — Apply

#### Task 5: Применить DDL через `db:push`
- **Команда:** `pnpm --filter @oplati/db db:push`
- **Использует:** `DATABASE_URL_DIRECT` (порт 5432, не pooler) из `apps/web/.env.local` или корневого `.env`.
- **Защита от data-loss:** drizzle-kit интерактивно спросит при destructive-changes — отвечать **No**, схема ожидаемо пустая, никаких потерь не должно быть. Если что-то спросит — это сигнал перепроверить state БД через Supabase MCP.
- **Логирование:** drizzle-kit печатает применяемый SQL.

#### Task 6: Применить RLS через Supabase MCP
- **Инструмент:** `mcp__claude_ai_Supabase__apply_migration`
- **Аргументы:** `project_id=nyxijwpuvctmvemaemqn`, `name=enable_rls`, `query=` содержимое `0001_enable_rls.sql`.
- **Альтернатива (только для отладки):** `execute_sql` — тот же SQL, но не оставит запись в `supabase_migrations.schema_migrations`. Не использовать для финального прогона.

### Phase 5 — Verification

#### Task 7: Smoke-проверка через Supabase MCP
- **Шаги:**
  1. `list_tables(project_id, schemas=['public'], verbose=true)` — убедиться, что присутствуют `users`, `staff`, `conversations`, `messages` с правильными колонками, типами, FK.
  2. `execute_sql`: `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('users','staff','conversations','messages') ORDER BY relname;` — все четыре `relrowsecurity = true`.
  3. `execute_sql`: `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='users';` — partial unique видны через `WHERE` в `indexdef`.
  4. **Positive insert:** `INSERT INTO users (telegram_id, display_name) VALUES ('test-tg-1', 'Test') RETURNING id;` затем `DELETE FROM users WHERE id = '<returned-id>';`.
  5. **Negative insert (CHECK):** `INSERT INTO users (display_name) VALUES ('No identity');` — должен упасть на CHECK constraint.

#### Task 8: Прогнать typecheck/lint/build
- **Команды:** `pnpm typecheck`, `pnpm lint`, `pnpm build` (последовательно из корня).
- **Зачем:** удаление 5 таблиц из schema.ts не должно ничего сломать в `apps/web` на этом milestone (импортов orders/payments не должно быть), но проверить — обязательно. Если будут TS-ошибки на удалённые типы — устранить.

#### Task 9: Закрыть milestone в `.ai-factory/ROADMAP.md`
- **Файл:** `.ai-factory/ROADMAP.md`
- **Правки:**
  - Строка 12: `- [ ]` → `- [x]` для «Базовая схема БД».
  - Таблица Completed: добавить `| Базовая схема БД | 2026-04-27 |`.
- Это последний шаг перед коммитом, делается в `/aif-verify`.

## Commit Plan

Дискретные точки фиксации (по 3 задачи):

| Commit | После задач | Сообщение |
|---|---|---|
| 1 | 1 + 2 | `feat(db): scope schema to users/staff/conversations/messages, fix users invariants` |
| 2 | 3 + 4 | `feat(db): generate initial migration + enable_rls custom migration` |
| 3 | 5 + 6 + 7 | `chore(db): apply base schema and RLS to Supabase` |
| 4 | 8 + 9 | `chore: close milestone "Базовая схема БД"` |

Conventional Commits, ≤72 символа в заголовке (по `docs/coding-standards.md`).

## Definition of Done (этот milestone)

- [x] `packages/db/src/schema.ts` содержит ровно 4 таблицы и 4 enum'а.
- [x] `users` корректно отражает docs (partial unique + CHECK).
- [x] `packages/db/migrations/0000_*.sql` и `0001_enable_rls.sql` закоммичены.
- [x] В Supabase `nyxijwpuvctmvemaemqn` присутствуют 4 таблицы, 4 enum, FK к `staff` работают, RLS включён на всех 4.
- [x] Positive insert работает, negative (без identity) падает с CHECK.
- [x] `pnpm typecheck && pnpm lint && pnpm build` зелёные.
- [x] `.ai-factory/ROADMAP.md`: `[x] Базовая схема БД` + строка в Completed.

## Что НЕ входит в этот план

- Repository-функции (`getOrCreateUserByTelegramId`, `appendMessage`) — это следующий milestone «Preview-деплой Vercel fra1» (там же будет первый end-to-end smoke с записью в Supabase).
- RLS-политики для operator/supervisor/admin — milestone «Минимальная админка».
- Storage buckets и их политики — milestone «Минимальная админка».
- Триггеры для `updated_at` — пока обновляем в коде вручную (`docs/database.md` допускает оба варианта).
- Seed каталога услуг — milestone «Расширение схемы БД».
