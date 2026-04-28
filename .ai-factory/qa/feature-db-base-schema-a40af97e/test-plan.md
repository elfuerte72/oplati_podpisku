## Test Plan: Базовая схема БД (`users`, `staff`, `conversations`, `messages`)

**Date:** 2026-04-28
**Branch / Version:** `feature/db-base-schema` (uncommitted; будет в первом merge в `main`)
**Environment:** Supabase project `nyxijwpuvctmvemaemqn` (dev), локальный pnpm/Turborepo, Next.js 16 dev-сервер, MCP Supabase tools

---

### 1. Testing Goal

Убедиться, что:
- DB-схема в Supabase соответствует декларации в `packages/db/src/schema.ts` и спецификации `docs/database.md`.
- Все защитные инварианты (RLS, CHECK `users_identity_present`, partial unique индексы, FK ON DELETE) работают на уровне СУБД, а не в приложении.
- Существующий runtime (`/api/bot`, `/api/health`) продолжает функционировать после включения RLS — `service_role` ключ обходит блокировку.
- Drizzle-kit snapshot и реальная БД синхронны: `db:push` выводит «No changes detected».
- Audit trail миграций в `supabase_migrations.schema_migrations` содержит все три применённые миграции в правильном порядке.

---

### 2. Test Scope

**In Scope** — тестируем:

- DDL: 4 таблицы (`users`, `staff`, `conversations`, `messages`) и 4 enum (`user_channel`, `staff_role`, `handoff_mode`, `message_role`) — структура колонок, типы, default'ы, FK.
- Инварианты `users`: CHECK `users_identity_present`, partial unique по `telegram_id`, partial unique по `web_session_id`.
- RLS: включён на всех 4 таблицах; default-deny при отсутствии политик; обход через `service_role`.
- ON DELETE поведение: `cascade` на `conversations.user_id → users.id` и `messages.conversation_id → conversations.id`.
- Идемпотентность миграции `0001_enable_rls.sql` и `0002_lively_supernaut.sql` (повторное применение не ломает БД).
- Drizzle-kit `db:push` через session-pooler URL — успешный коннект и «No changes detected».
- Регрессия `apps/web`: typecheck, lint, build остаются зелёными; Telegram webhook продолжает работать.

**Out of Scope** — не тестируем:

- Repository-функции (`getOrCreateUserByTelegramId`, `appendMessage`) — их нет на этом milestone, появятся в «Preview-деплой Vercel fra1».
- RLS-политики для operator/supervisor/admin — отложено на milestone «Минимальная админка».
- Storage buckets, Auth-роли — на этом milestone не трогали.
- Триггеры `updated_at` — план явно отказался от триггеров, обновление в коде вручную (но кода ещё нет).
- Услуги/заказы/платежи/вложения — milestone «Расширение схемы БД».
- Производительность под нагрузкой 50 заказов/день — преждевременно, пока нет приложения, работающего с этими таблицами.

---

### 3. Test Types

| Type | Priority | Area |
|---|---|---|
| Functional | 🔴 High | Существование 4 таблиц и 4 enum в `public`; типы колонок; default'ы |
| Functional | 🔴 High | CHECK `users_identity_present` блокирует невалидный INSERT |
| Functional | 🔴 High | Partial unique индексы работают только при NOT NULL |
| Functional | 🔴 High | FK ON DELETE cascade на `conversations` и `messages` |
| Security | 🔴 High | RLS включён на 4 таблицах; default-deny для anon-ключа |
| Security | 🔴 High | `service_role` обходит RLS — server-only код продолжает читать/писать |
| Regression | 🟡 Medium | `pnpm typecheck`, `pnpm lint`, `pnpm build` зелёные |
| Regression | 🟡 Medium | `pnpm --filter @oplati/db db:push` → «No changes detected» |
| Regression | 🟡 Medium | Telegram webhook `/api/bot` отвечает на `/start` (не сломался от RLS) |
| Edge cases | 🟡 Medium | Две строки `users` с `telegram_id IS NULL` — допускаются (partial unique) |
| Edge cases | 🟡 Medium | Идемпотентное повторное применение `0001_enable_rls.sql` |
| Negative | 🟡 Medium | INSERT в `users` без identity → ошибка `users_identity_present` |
| Negative | 🟡 Medium | INSERT enum-значения вне списка → ошибка |
| Negative | 🟡 Medium | INSERT FK на несуществующий `staff.id` → ошибка |
| Performance | 🟢 Low | Не входит в этот milestone |

---

### 4. Test Data

| Category | Data | Purpose |
|---|---|---|
| Valid (Telegram-only user) | `INSERT INTO users (telegram_id, display_name) VALUES ('test-tg-1','Иван')` | Happy path для будущего бот-flow |
| Valid (web-only user) | `INSERT INTO users (web_session_id, display_name) VALUES ('sess-abc','Anonymous')` | Happy path для будущего веб-чата |
| Valid (both identities) | `INSERT INTO users (telegram_id, web_session_id, display_name) VALUES ('test-tg-2','sess-def','Linked')` | Сценарий «связали Telegram и web» |
| Valid (staff operator) | `INSERT INTO staff (email, display_name, role) VALUES ('op@test.local','Оператор','operator')` | Базовый seed для будущей админки |
| Valid (conversation+message) | `INSERT INTO conversations (user_id, channel) VALUES ('<user-uuid>', 'telegram') RETURNING id;` затем `INSERT INTO messages (conversation_id, role, content) VALUES ('<conv-uuid>','user','Привет')` | Happy path AI-чата |
| Boundary | `INSERT ... language='ru'` (default) — без явного указания language | Default-значение |
| Boundary | Два `INSERT ... web_session_id='same-id'` подряд | Должен упасть на partial unique |
| Boundary | Два `INSERT ... telegram_id IS NULL, web_session_id IS NULL` — оба должны упасть на CHECK | CHECK срабатывает раньше unique |
| Invalid (CHECK) | `INSERT INTO users (display_name) VALUES ('No identity')` — без обоих identity | Negative: CHECK |
| Invalid (FK) | `INSERT INTO conversations (user_id, channel) VALUES ('00000000-0000-0000-0000-000000000000','telegram')` — несуществующий user_id | Negative: FK |
| Invalid (enum) | `INSERT INTO conversations (user_id, channel) VALUES ('<user-uuid>','sms')` — `sms` не в `user_channel` | Negative: enum |
| Invalid (FK staff) | `INSERT INTO conversations (user_id, channel, assigned_operator_id) VALUES ('<user-uuid>','telegram','00000000-0000-0000-0000-000000000000')` | Negative: FK на staff |
| Special (RLS via anon) | Запрос с `SUPABASE_ANON_KEY` к таблице `users` через REST API Supabase | Должен вернуть 0 строк (default-deny) |
| Special (RLS via service_role) | Запрос с `SUPABASE_SERVICE_ROLE_KEY` к таблице `users` | Должен вернуть все строки |

---

### 5. Preconditions

- [ ] Supabase project `nyxijwpuvctmvemaemqn` доступен; мигации `base_schema_users_staff_conversations_messages`, `enable_rls`, `sync_rls_state_in_drizzle_snapshot` присутствуют в `supabase_migrations.schema_migrations`.
- [ ] Локально работает `pnpm` и `pnpm --filter @oplati/db db:push` коннектится через session-pooler.
- [ ] В `.env`/`apps/web/.env.local` `DATABASE_URL_DIRECT` указывает на session-pooler (`...:5432`), пароль реальный.
- [ ] Supabase MCP доступен (`mcp__claude_ai_Supabase__execute_sql`, `list_tables`, `list_migrations`).
- [ ] `SUPABASE_ANON_KEY` и `SUPABASE_SERVICE_ROLE_KEY` присутствуют в env, не подменены.
- [ ] Есть `curl` или Postman/HTTPie для проверки RLS через REST API Supabase.

---

### 6. Acceptance Criteria

- [ ] Все 🔴 High-priority test cases (TC-01, TC-02, TC-03, TC-04, TC-05, TC-06) выполняются успешно.
- [ ] Negative-сценарии (TC-08, TC-09, TC-10, TC-11) возвращают именно ту ошибку, которая ожидается в test cases (не любую другую).
- [ ] Регрессия (TC-12, TC-13, TC-14): build зелёный, `db:push` "No changes detected", Telegram webhook отвечает.
- [ ] RLS-default-deny подтверждён через REST API с anon-ключом — пустой массив строк, не 401/403.
- [ ] Audit trail в `supabase_migrations.schema_migrations` содержит ровно три миграции в правильном порядке.

---

### 7. Plan Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Тесты используют общий dev-Supabase (не изолированный) | Medium | Каждый INSERT-тест явно DELETE'ит созданные строки. Ничего не остаётся в БД после прогона. Альтернатива — создать staging-проект (out of scope). |
| Race condition при параллельном INSERT с одинаковым `telegram_id` | Low | На этом milestone repository-функций нет, race не проявляется. Зафиксировано в Edge cases как «дальше — использовать `INSERT ... ON CONFLICT`». |
| RLS через REST API требует правильный URL и заголовки | Medium | TC-06 содержит точный `curl` пример с `apikey` и `Authorization: Bearer`. |
| `pgcrypto` extension может не быть на чистом Postgres | Low | Supabase project уже имеет `pgcrypto`. На локальной разработке без Supabase не тестируем (out of scope). |
| Потеря данных при ON DELETE cascade | Medium | TC-04 явно создаёт временные данные и проверяет каскад; на prod-данных не запускается. |

---

### 8. Checklist

| Check | Priority |
|---|---|
| 4 таблицы и 4 enum существуют в `public` с правильными типами | High |
| `rls_enabled = true` на всех 4 таблицах | High |
| `users_identity_present` CHECK блокирует невалидный INSERT | High |
| Partial unique по `telegram_id` срабатывает только при NOT NULL | High |
| Partial unique по `web_session_id` срабатывает только при NOT NULL | High |
| Две строки `users` с `telegram_id IS NULL` сосуществуют | High |
| FK ON DELETE cascade на conversations и messages | High |
| Anon-ключ через REST не возвращает данные (default-deny) | High |
| `service_role` ключ через REST возвращает все данные | High |
| INSERT с невалидным enum / несуществующим FK падает | Medium |
| Миграция `0001_enable_rls.sql` идемпотентна | Medium |
| `pnpm typecheck && lint && build` — зелёные | Medium |
| `pnpm --filter @oplati/db db:push` → "No changes detected" | Medium |
| Telegram webhook `/api/bot` отвечает на `/start` после RLS | Medium |
| `supabase_migrations.schema_migrations` содержит 3 миграции | Medium |
