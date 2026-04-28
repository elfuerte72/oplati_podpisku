## Change Summary

**Branch:** `feature/db-base-schema`
**Base:** `main`
**Commits:** 2
- `02af105` — `feat(db): apply base schema users/staff/conversations/messages`
- `f774e85` — `chore(skills): install aif-qa skill from lee-to/ai-factory@2.x`

**Changed files:** 22 (3 modified, 19 added) | **Diff:** +3148 / -171 lines
**Risk level:** 🟡 Medium

---

### What Changed

Реализован milestone «Базовая схема БД» из ROADMAP. В Supabase развёрнута начальная схема для пользователей и переписки: четыре таблицы (`users`, `staff`, `conversations`, `messages`) с минимальным набором инвариантов, защитой данных через Row Level Security и audit trail миграций. Drizzle-схема сужена до этой базы — таблицы заказов/услуг/платежей/вложений сознательно отложены до следующего milestone «Расширение схемы БД».

Дополнительно установлен инструмент функционального QA — скилл `aif-qa` из репозитория `lee-to/ai-factory@2.x`, регистрирует команду `/aif-qa` с трёхэтапным pipeline (change-summary → test-plan → test-cases). QA-артефакты этого прогона зафиксированы в первом коммите как часть milestone'а.

Не отражено в git diff, но является частью milestone'а:
- 3 миграции применены в Supabase project `nyxijwpuvctmvemaemqn` через MCP `apply_migration` (audit trail в `supabase_migrations.schema_migrations`).
- `.env`/`.env.local` обновлены: `DATABASE_URL_DIRECT` переключён на session-pooler URL с реальным паролем (был плейсхолдер `[YOUR-PASSWORD]` + IPv6-only direct host).

---

### Affected Areas

**Commit 02af105 — feat(db) Группа изменений:**

| Component | Change type | Description |
|---|---|---|
| `packages/db/src/schema.ts` | Changed | Сужена с 9 таблиц до 4 (`users`, `staff`, `conversations`, `messages`). Удалены 5 enum (`order_status`, `payment_provider`, `payment_status`, `attachment_kind`, `actor_type`). Добавлен CHECK `users_identity_present`, partial unique индексы по `telegram_id`/`web_session_id`, `.enableRLS()` на 4 таблицах. |
| `packages/db/migrations/0000_brave_tiger_shark.sql` | Added | Первая миграция: DDL для 4 таблиц + 4 enum, FK к `staff`, partial unique, CHECK. |
| `packages/db/migrations/0001_enable_rls.sql` | Added | Кастомная миграция: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` на 4 таблицы. |
| `packages/db/migrations/0002_lively_supernaut.sql` | Added | Идемпотентная sync-миграция drizzle snapshot ↔ БД. Содержит заголовочный комментарий о причине дубликата. |
| `packages/db/migrations/meta/*.json` | Added | Drizzle-kit snapshots/journal — auto-generated, ручному QA не подлежат. |
| `.ai-factory/ROADMAP.md` | Changed | Milestone «Базовая схема БД» помечен `[x]`; добавлена строка в Completed (`2026-04-28`). |
| `.ai-factory/plans/feature-db-base-schema.md` | Added | Plan-документ с задачами и DoD (артефакт workflow). |
| `.ai-factory/patches/2026-04-28-11.19.md` | Added | Patch-урок про синхронизацию drizzle snapshot ↔ кастомные SQL-миграции. |
| `.ai-factory/qa/feature-db-base-schema-a40af97e/*` | Added | QA-артефакты предыдущего прогона (этот коммит обновляется текущим прогоном). |

**Commit f774e85 — chore(skills) Группа изменений:**

| Component | Change type | Description |
|---|---|---|
| `.ai-factory.json` | Changed | `aif-qa` добавлен в `installedSkills` (alphabetical position между `aif-plan` и `aif-review`). |
| `.claude/skills/aif-qa/SKILL.md` | Added | Манифест скилла: 3-stage pipeline, allowed-tools, branch-slug logic. |
| `.claude/skills/aif-qa/references/{CHANGE-SUMMARY,TEST-PLAN,TEST-CASES}.md` | Added | Детальные инструкции для каждого этапа pipeline. |
| `.claude/skills/aif-qa/templates/{CHANGE-SUMMARY,TEST-PLAN,TEST-CASES}.md` | Added | Шаблоны итоговых артефактов. |

**Out-of-tree changes (применено вручную, не в git):**

| Component | Description |
|---|---|
| Supabase БД `nyxijwpuvctmvemaemqn` | Применены миграции `base_schema_users_staff_conversations_messages`, `enable_rls`, `sync_rls_state_in_drizzle_snapshot`. |
| `.env`, `apps/web/.env.local` | `DATABASE_URL_DIRECT` переписан с прямого host'а на session-pooler. Эти файлы в `.gitignore`, в diff не появятся. |

---

### Risks

🔴 **Critical (must verify):**

- **Целостность RLS на 4 таблицах.** RLS включён без политик. Любой клиент с anon-key или auth-user-key должен получать 0 строк на любых SELECT/INSERT/UPDATE/DELETE. Сервер ходит `service_role` ключом и обходит RLS — это главная гарантия, что приложение продолжит работать. Если в коде где-то остался не-service-role клиент, он молча перестанет видеть данные.
- **Инвариант `users_identity_present` блокирует невалидные INSERT.** Без `telegram_id` или `web_session_id` запись `users` создать невозможно (CHECK constraint). Любой repository-код в будущем должен это учитывать — иначе runtime-ошибка. Сейчас функций `getOrCreateUserByTelegramId`/`getOrCreateUserByWebSession` нет, но при их добавлении (следующий milestone «Preview-деплой Vercel») это становится hot path.
- **FK ON DELETE: `cascade` для conversation→user, `cascade` для message→conversation.** Удаление `users.id` обнуляет всю переписку. Это сейчас «безопасно» (никто не удаляет users), но при добавлении админ-функции «удалить пользователя» (Sprint 2+) будет каскад на messages — возможна потеря audit trail. Решение оставлено осознанно (см. `docs/database.md`).

🟡 **Medium (should verify):**

- **Идемпотентность миграции `0002_lively_supernaut.sql`.** Содержит ту же `ALTER TABLE ... ENABLE RLS`, что уже применена в `0001`. SQL idempotent, но если кто-то попытается «пере-применить» миграцию вручную или откатить её — поведение неочевидное. Заголовочный комментарий снижает риск, но не устраняет полностью.
- **Partial unique индексы по `telegram_id`/`web_session_id`.** Уникальность только для NOT NULL значений. Корректно для сценариев «у части пользователей только Telegram, у части только web-сессия, у части оба». Но это значит — две строки с `telegram_id = NULL` создаваться будут, и два независимых вызова `INSERT ... web_session_id='X'` параллельно могут создать дубликаты при race condition (если код не использует `ON CONFLICT`).
- **Смена `DATABASE_URL_DIRECT` на session-pooler.** Все CLI-инструменты (drizzle-kit, psql напрямую) теперь идут через pooler. Для миграций это работает, но если кто-то завязан на «честный direct» (например, для long-running migrations или `pg_dump`), потребуется настроить отдельную переменную или включить IPv4 add-on. На Vercel runtime используется `DATABASE_URL` (transaction pooler 6543) — runtime не затронут.
- **`aif-qa` скилл — новый процесс в проекте.** Команда `/aif-qa` теперь интегрирована, но пока никто (включая разработчика) не отработал привычку вызывать её. Риск — артефакты прогонов копятся, не используются.

🟢 **Low (nice to verify):**

- **`messages.staff_id` без отдельного индекса.** Запросы по «активность оператора X» без индекса будут seq-scan'ом. Сейчас таких запросов нет, но при появлении админ-экрана «активность оператора» может потребоваться индекс.
- **`updated_at` триггеров нет — обновление через приложение.** На текущем milestone repository-кода нет, потому проблема не проявляется. При написании `update`-запросов разработчик должен помнить вручную выставлять `updatedAt: new Date()` (или использовать `$onUpdate(...)` в schema.ts).
- **`pgcrypto` extension для `gen_random_uuid()`.** Уже установлено в Supabase. Если кто-то поднимет проект на чистом Postgres — миграция упадёт без `CREATE EXTENSION pgcrypto`. Документировать в `docs/supabase-setup.md`.
- **QA-артефакты `.ai-factory/qa/<branch-slug>/` коммитятся в репо.** Решение по политике (хранить vs `.gitignore`) пока не принято. Может разрастись на больших ветках. Не критично для текущего milestone.

---

### Testing Recommendations

**First priority:**

- [ ] **Smoke 4 таблиц:** `list_tables` через Supabase MCP возвращает `users`, `staff`, `conversations`, `messages` с `rls_enabled=true`.
- [ ] **CHECK constraint `users_identity_present`:** `INSERT INTO users (display_name) VALUES ('x')` должен вернуть ошибку `users_identity_present`.
- [ ] **Partial unique:** дважды `INSERT INTO users (telegram_id, ...) VALUES ('tg-1', ...)` — второй должен упасть на `users_telegram_id_idx`. При `telegram_id IS NULL` уникальность не должна срабатывать.
- [ ] **FK ON DELETE cascade:** создать user → conversation → messages, удалить user, проверить что conversations и messages исчезли.
- [ ] **RLS-deny-by-default:** запрос с anon-ключом (`SUPABASE_ANON_KEY`) должен вернуть 0 строк из `users`/`staff`/`conversations`/`messages` даже при наличии данных. Запрос с `SUPABASE_SERVICE_ROLE_KEY` — все строки.
- [ ] **Audit trail:** `list_migrations` через MCP возвращает ровно три миграции в правильном порядке.

**Regression:**

- [ ] **`pnpm typecheck` / `pnpm lint` / `pnpm build`** во всех 4 пакетах — зелёные.
- [ ] **`pnpm --filter @oplati/db db:push`** — должен сказать `[i] No changes detected`. Если предлагает что-то изменить → snapshot drizzle и БД разошлись.
- [ ] **Telegram webhook `/api/bot`** (предыдущий milestone) — продолжает отвечать на `/start` и текстовые сообщения. Server-only код использует `service_role` ключ — RLS не должен ломать поток.
- [ ] **`/api/health`** — возвращает 200 (если внутри есть обращение к БД через anon-ключ — теперь вернёт пусто, что может быть багом).
- [ ] **Vercel preview-деплой** на пуш ветки — успешный build, бот `@dev_test_podpiska_bot` отвечает на /start.

**Skill verification:**

- [ ] `/aif-qa --all` на этой ветке завершается без ошибок (этот прогон).
- [ ] Артефакты в `.ai-factory/qa/feature-db-base-schema-a40af97e/` обновлены и содержат корректную дельту по 22 файлам.
