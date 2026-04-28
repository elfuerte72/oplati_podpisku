## Test Cases: Базовая схема БД (`users`, `staff`, `conversations`, `messages`)

> Все SQL-команды выполняются через Supabase MCP `execute_sql` (project_id `nyxijwpuvctmvemaemqn`), либо `psql $DATABASE_URL_DIRECT`. RLS-кейсы (TC-06, TC-07) — через `curl` к Supabase REST API.

---

### TC-01: Существование 4 таблиц и 4 enum в `public`

**Priority:** High
**Type:** Positive

**Precondition:** Миграции `0000`, `0001`, `0002` применены в Supabase.

**Steps:**

1. Через Supabase MCP вызвать `list_tables(project_id='nyxijwpuvctmvemaemqn', schemas=['public'], verbose=true)`.
2. Сравнить результат со списком ожидаемых таблиц и колонок.

**Expected result:**

- В `public` ровно 4 таблицы: `users`, `staff`, `conversations`, `messages`.
- На каждой таблице `rls_enabled = true`.
- `users` имеет 10 колонок: `id` (uuid, pk), `telegram_id` (text, nullable), `web_session_id` (text, nullable), `display_name` (text, nullable), `language` (text, default 'ru'), `phone` (text, nullable), `email` (text, nullable), `notes` (text, nullable), `created_at` (timestamptz, default now()), `updated_at` (timestamptz, default now()).
- `staff` имеет 8 колонок, `conversations` — 8, `messages` — 7 (все колонки совпадают со `schema.ts`).
- FK: `conversations.user_id → users.id`, `conversations.assigned_operator_id → staff.id`, `messages.conversation_id → conversations.id`, `messages.staff_id → staff.id`.
- 4 enum (`user_channel`, `staff_role`, `handoff_mode`, `message_role`) с правильными значениями.

**Test data:**

```sql
SELECT typname, array_agg(enumlabel ORDER BY enumsortorder)
FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
WHERE typname IN ('user_channel','staff_role','handoff_mode','message_role')
GROUP BY typname ORDER BY typname;
```

---

### TC-02: CHECK `users_identity_present` блокирует невалидный INSERT

**Priority:** High
**Type:** Negative

**Precondition:** Таблица `users` пуста или содержит произвольные данные. Запрос идёт под `service_role`-ключом (через MCP).

**Steps:**

1. Выполнить `INSERT INTO users (display_name) VALUES ('No identity');`
2. Проверить ответ.

**Expected result:**

- Запрос завершается ошибкой Postgres `23514: new row for relation "users" violates check constraint "users_identity_present"`.
- В таблицу строка не попадает (`SELECT count(*) FROM users WHERE display_name='No identity'` возвращает 0).

**Test data:**

```sql
INSERT INTO users (display_name) VALUES ('No identity');
-- Должен упасть: ERROR 23514 users_identity_present
```

---

### TC-03: Partial unique индекс по `telegram_id` срабатывает только при NOT NULL

**Priority:** High
**Type:** Positive + Negative

**Precondition:** Таблица `users` не содержит записей с `telegram_id='qa-tg-uniq'`. Service_role.

**Steps:**

1. `INSERT INTO users (telegram_id, display_name) VALUES ('qa-tg-uniq', 'First') RETURNING id;` — запомнить id.
2. `INSERT INTO users (telegram_id, display_name) VALUES ('qa-tg-uniq', 'Second');` — должен упасть.
3. `INSERT INTO users (web_session_id, display_name) VALUES ('qa-sess-A', 'Web A');` — успех.
4. `INSERT INTO users (web_session_id, display_name) VALUES ('qa-sess-B', 'Web B');` — успех.
5. *(Edge case: два NULL в `telegram_id`)* Шаги 3 и 4 уже это покрывают — у обеих строк `telegram_id IS NULL`, и они успешно сосуществуют, потому что partial unique игнорирует NULL.
6. Cleanup: `DELETE FROM users WHERE telegram_id='qa-tg-uniq' OR web_session_id IN ('qa-sess-A','qa-sess-B');`.

**Expected result:**

- Шаг 1 — успех, возвращён uuid.
- Шаг 2 — ошибка `23505 duplicate key value violates unique constraint "users_telegram_id_idx"`.
- Шаги 3 и 4 — оба INSERT'а успешны, две строки с `telegram_id IS NULL` сосуществуют.
- Cleanup удаляет ровно 3 строки.

**Test data:**

```sql
INSERT INTO users (telegram_id, display_name) VALUES ('qa-tg-uniq', 'First');
INSERT INTO users (telegram_id, display_name) VALUES ('qa-tg-uniq', 'Second'); -- ERROR 23505
INSERT INTO users (web_session_id, display_name) VALUES ('qa-sess-A', 'Web A');
INSERT INTO users (web_session_id, display_name) VALUES ('qa-sess-B', 'Web B');
DELETE FROM users WHERE telegram_id='qa-tg-uniq' OR web_session_id IN ('qa-sess-A','qa-sess-B');
```

---

### TC-04: FK ON DELETE cascade на `conversations` и `messages`

**Priority:** High
**Type:** Positive

**Precondition:** Service_role ключ. Таблицы пусты или нет конфликтов с тестовыми данными.

**Steps:**

1. Создать пользователя: `INSERT INTO users (telegram_id, display_name) VALUES ('qa-cascade-tg', 'Cascade Test') RETURNING id;` — запомнить `<USER_ID>`.
2. Создать conversation: `INSERT INTO conversations (user_id, channel) VALUES ('<USER_ID>', 'telegram') RETURNING id;` — запомнить `<CONV_ID>`.
3. Создать сообщения: `INSERT INTO messages (conversation_id, role, content) VALUES ('<CONV_ID>', 'user', 'Hi'), ('<CONV_ID>', 'assistant', 'Hello');`.
4. Проверить counts: `SELECT count(*) FROM conversations WHERE user_id='<USER_ID>';` → `1`. `SELECT count(*) FROM messages WHERE conversation_id='<CONV_ID>';` → `2`.
5. Удалить пользователя: `DELETE FROM users WHERE id='<USER_ID>';`.
6. Проверить counts: тот же `SELECT count(*) FROM conversations WHERE user_id='<USER_ID>'` → `0`; `SELECT count(*) FROM messages WHERE conversation_id='<CONV_ID>'` → `0`.

**Expected result:**

- Шаги 1–3 — успех.
- Шаг 4 — counts соответствуют (1 и 2).
- Шаг 5 — успех (нет блокировки FK).
- Шаг 6 — обе counts равны 0 (cascade сработал на conversations.user_id, затем messages.conversation_id).

---

### TC-05: Audit trail миграций в `supabase_migrations.schema_migrations`

**Priority:** High
**Type:** Positive

**Precondition:** Подключение к Supabase MCP.

**Steps:**

1. Через MCP `list_migrations(project_id='nyxijwpuvctmvemaemqn')`.
2. Сравнить список с ожидаемым.

**Expected result:**

Возвращены ровно три миграции в порядке возрастания версии:
- `base_schema_users_staff_conversations_messages`
- `enable_rls`
- `sync_rls_state_in_drizzle_snapshot`

Никаких лишних миграций, никаких rollback'ов.

---

### TC-06: RLS — anon-ключ не возвращает данные (default-deny)

**Priority:** High
**Type:** Security / Positive

**Precondition:** В `users` есть хотя бы одна строка (создать через service_role: `INSERT INTO users (telegram_id, display_name) VALUES ('qa-rls-anon', 'RLS Test') RETURNING id;`). `SUPABASE_ANON_KEY` известен и активен.

**Steps:**

1. Через `curl` сделать GET к Supabase REST с anon-ключом:
   ```bash
   curl -s "https://nyxijwpuvctmvemaemqn.supabase.co/rest/v1/users?select=*" \
     -H "apikey: $SUPABASE_ANON_KEY" \
     -H "Authorization: Bearer $SUPABASE_ANON_KEY"
   ```
2. Аналогично проверить `staff`, `conversations`, `messages`.
3. Cleanup: `DELETE FROM users WHERE telegram_id='qa-rls-anon';` (через service_role).

**Expected result:**

- Все 4 запроса возвращают HTTP 200 и пустой массив `[]` (не 401, не 403).
- Это подтверждает, что RLS включён и без политик возвращает 0 строк, **а не** блокирует запрос на уровне роли (это важное отличие — ошибка 401/403 могла бы означать, что Postgres вообще не пускает anon, а не RLS).

**Test data:**

```bash
ANON_KEY="..."  # из .env SUPABASE_ANON_KEY
for table in users staff conversations messages; do
  curl -s -w "\nstatus=%{http_code}\n" \
    "https://nyxijwpuvctmvemaemqn.supabase.co/rest/v1/$table?select=*" \
    -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $ANON_KEY"
done
# Ожидание: для каждой таблицы тело "[]" и status=200
```

---

### TC-07: RLS — `service_role` ключ возвращает все данные

**Priority:** High
**Type:** Security / Positive

**Precondition:** В `users` есть хотя бы одна строка. `SUPABASE_SERVICE_ROLE_KEY` известен.

**Steps:**

1. `curl` GET к `users` с service_role-ключом:
   ```bash
   curl -s "https://nyxijwpuvctmvemaemqn.supabase.co/rest/v1/users?select=id,display_name" \
     -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
   ```
2. Сравнить с прямым `SELECT count(*) FROM users` через MCP.

**Expected result:**

- HTTP 200, тело — массив с теми же строками, что вернул `SELECT count(*) FROM users` (с точностью до количества).
- Это подтверждает, что `service_role` обходит RLS.

---

### TC-08: INSERT с невалидным enum-значением

**Priority:** Medium
**Type:** Negative

**Precondition:** Service_role. Создан валидный `users.id` (или взять любой существующий) — `<USER_ID>`.

**Steps:**

1. `INSERT INTO conversations (user_id, channel) VALUES ('<USER_ID>', 'sms');`.
2. Аналогично для других enum: `INSERT INTO messages (conversation_id, role, content) VALUES ('<CONV_ID>', 'admin', 'x')` (`admin` — не в `message_role`).

**Expected result:**

- Запросы падают с ошибкой `22P02: invalid input value for enum user_channel: "sms"` (и аналогично для message_role).
- В таблицу строки не попадают.

---

### TC-09: INSERT FK на несуществующий `staff.id`

**Priority:** Medium
**Type:** Negative

**Precondition:** Service_role. Создан валидный `users.id` (`<USER_ID>`).

**Steps:**

1. `INSERT INTO conversations (user_id, channel, assigned_operator_id) VALUES ('<USER_ID>', 'telegram', '00000000-0000-0000-0000-000000000000');`.

**Expected result:**

- Ошибка `23503: insert or update on table "conversations" violates foreign key constraint "conversations_assigned_operator_id_staff_id_fk"`.
- В `conversations` строка не попадает.

---

### TC-10: INSERT FK на несуществующий `users.id`

**Priority:** Medium
**Type:** Negative

**Steps:**

1. `INSERT INTO conversations (user_id, channel) VALUES ('00000000-0000-0000-0000-000000000000', 'telegram');`.

**Expected result:**

- Ошибка `23503: ... violates foreign key constraint "conversations_user_id_users_id_fk"`.
- В `conversations` ничего не попадает.

---

### TC-11: Идемпотентность `0001_enable_rls.sql`

**Priority:** Medium
**Type:** Positive (idempotency)

**Precondition:** RLS уже включён на 4 таблицах.

**Steps:**

1. Через MCP `execute_sql`:
   ```sql
   ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
   ALTER TABLE "staff" ENABLE ROW LEVEL SECURITY;
   ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
   ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
   ```
2. Проверить `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('users','staff','conversations','messages');` — все 4 строки `relrowsecurity = true`.

**Expected result:**

- Шаг 1 завершается без ошибок (Postgres не падает на повторном ENABLE).
- Шаг 2 показывает, что RLS остался включён.

---

### TC-12: `pnpm typecheck && pnpm lint && pnpm build` — зелёные

**Priority:** Medium
**Type:** Regression

**Precondition:** Из корня репо `pnpm install` уже выполнен.

**Steps:**

1. `cd /Users/penkin/projects/oplati_podpicky && pnpm typecheck`.
2. `pnpm lint`.
3. `pnpm build`.

**Expected result:**

- Все три команды выходят с кодом 0.
- В выводе `build` — `4 successful, 4 total` для Turborepo (или 1 successful если только web).
- Никаких TS-ошибок про удалённые типы (`OrderStatus`, `Payment`...).

---

### TC-13: `db:push` через session-pooler — "No changes detected"

**Priority:** Medium
**Type:** Regression

**Precondition:** В `.env` `DATABASE_URL_DIRECT` = session-pooler URL с реальным паролем. Локальная сеть имеет доступ к `aws-0-eu-west-1.pooler.supabase.com:5432`.

**Steps:**

1. `set -a && source .env && set +a && pnpm --filter @oplati/db db:push`.
2. Прочитать вывод drizzle-kit.

**Expected result:**

- Прогресс «Pulling schema from database» завершается.
- В выводе появляется строка `[i] No changes detected`.
- **НЕТ** строк `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` (это бы означало, что snapshot и БД разошлись).
- Команда выходит с кодом 0.

---

### TC-14: Telegram webhook `/api/bot` отвечает после включения RLS

**Priority:** Medium
**Type:** Regression

**Precondition:** Локально запущен `pnpm --filter web dev` (или используется уже задеплоенный preview-бот `@dev_test_podpiska_bot`). `TELEGRAM_BOT_TOKEN` и `TELEGRAM_WEBHOOK_SECRET` заданы в env. Webhook зарегистрирован на текущем URL.

**Steps:**

1. Отправить `/start` боту в Telegram (вручную) или симулировать через `curl`:
   ```bash
   curl -sS -X POST "$APP_URL/api/bot" \
     -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"update_id":999999,"message":{"message_id":1,"date":1745846400,"chat":{"id":111111,"type":"private"},"from":{"id":111111,"is_bot":false,"first_name":"QA"},"text":"/start"}}'
   ```
2. Получить ответ HTTP и проверить telegram-чат на наличие приветствия от бота.

**Expected result:**

- HTTP 200 от `/api/bot`.
- Бот ответил в чате (или на симуляции — лог в Vercel/dev-консоли показывает успешный вызов AI и `sendMessage`).
- Ошибок про RLS / отказ доступа к Supabase в логах нет.

---

### TC-15: Connection через session-pooler с реальным паролем

**Priority:** Medium
**Type:** Regression / Configuration

**Precondition:** `.env` обновлён — `DATABASE_URL_DIRECT=postgresql://postgres.<project>:<password>@aws-0-...pooler.supabase.com:5432/postgres`.

**Steps:**

1. `psql "$DATABASE_URL_DIRECT" -c "SELECT current_user, inet_server_addr();"` (или через `pnpm --filter @oplati/db db:studio` → web UI открывается).

**Expected result:**

- Успешный коннект, `current_user` = `postgres.<project_ref>` (характерный признак pooler-юзера).
- Никаких DNS-ошибок про `db.<project>.supabase.co`.

---

## Test Data (based on test design techniques)

### Positive

* Telegram-only user: `INSERT INTO users (telegram_id, display_name) VALUES ('qa-tg-1', 'Иван');`
* Web-only user: `INSERT INTO users (web_session_id, display_name) VALUES ('qa-sess-1', 'Аноним');`
* Linked user: `INSERT INTO users (telegram_id, web_session_id, display_name) VALUES ('qa-tg-2', 'qa-sess-2', 'Linked');`
* Staff operator: `INSERT INTO staff (email, display_name, role) VALUES ('qa-op@test.local', 'Оператор', 'operator');`
* Default `language='ru'`: `INSERT INTO users (telegram_id) VALUES ('qa-default-lang');` → проверить, что `language='ru'`.
* Channel-варианты: `'telegram'`, `'web'` — оба валидны.
* Handoff-варианты: `'ai'` (default), `'operator'`.
* Message-роли: `'user'`, `'assistant'`, `'operator'`, `'system'`.
* Staff-роли: `'operator'` (default), `'supervisor'`, `'admin'`.

### Negative

* Без identity: `INSERT INTO users (display_name) VALUES ('Empty');` — CHECK violation.
* Дубль telegram_id: два INSERT'а с `telegram_id='dup'` — второй падает.
* Дубль web_session_id: два INSERT'а с `web_session_id='dup'` — второй падает.
* Невалидный enum: `channel='sms'`, `role='admin'` (для message_role), `handoff_mode='manual'`.
* Несуществующий FK: `user_id`, `conversation_id`, `staff_id`, `assigned_operator_id` с UUID `00000000-...`.
* Дубль staff.email: два INSERT'а в `staff` с одинаковым `email`.
* Дубль staff.auth_user_id: два INSERT'а в `staff` с одинаковым `auth_user_id`.
* Anon-ключ к таблицам — пустой массив (default-deny RLS).
* Anon-ключ INSERT/UPDATE/DELETE — должен молча провалиться (0 affected rows) или вернуть ошибку RLS.
