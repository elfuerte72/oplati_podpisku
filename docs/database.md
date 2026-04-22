# Схема базы данных

PostgreSQL 17 (Supabase). Имена — `snake_case`, множественное число для таблиц.

## Ключевые инварианты

1. **Деньги хранятся в копейках как `integer`.** Никогда не `numeric`/`float`.
2. **`order_events` append-only.** Изменение статуса = новая строка, старые не трогаются.
3. **Платежи идемпотентны** через `UNIQUE(provider, provider_ref)`.
4. **Все `id` — UUID v4** с `DEFAULT gen_random_uuid()`. Короткий `short_id` генерируется отдельно для человекочитаемости (напр. `ORD-7KX42`).
5. **Timestamps `WITH TIME ZONE`**, defaults `now()`.
6. **Нет каскадных удалений для `orders`** — `ON DELETE RESTRICT` от users. Заказы никогда не удаляются физически.
7. **RLS включён на всех таблицах с пользовательскими данными.**

## ENUM-ы

| Имя | Значения |
|---|---|
| `user_channel` | `telegram`, `web` |
| `staff_role` | `operator`, `supervisor`, `admin` |
| `order_status` | `draft`, `clarifying`, `kyc_required`, `ready_for_payment`, `pending_payment`, `paid`, `in_fulfillment`, `completed`, `failed`, `cancelled`, `expired`, `refund_requested`, `refunded` |
| `message_role` | `user`, `assistant`, `operator`, `system` |
| `handoff_mode` | `ai`, `operator` |
| `payment_provider` | `yookassa`, `cryptobot`, `sbp`, `manual` |
| `payment_status` | `pending`, `succeeded`, `failed`, `refunded` |
| `attachment_kind` | `payment_proof`, `kyc`, `fulfillment_proof`, `other` |
| `actor_type` | `system`, `user`, `operator`, `supervisor`, `ai`, `payment_provider` |

## Таблицы

### `users` — клиенты (Telegram + веб)

| Колонка | Тип | Nullable | Default | Комментарий |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `telegram_id` | `text` | yes | — | Telegram user id как строка |
| `web_session_id` | `text` | yes | — | Id веб-сессии (cookie-based) |
| `display_name` | `text` | yes | — | Имя из TG или введённое в веб-чате |
| `language` | `text` | no | `'ru'` | BCP-47 |
| `phone` | `text` | yes | — | E.164 |
| `email` | `text` | yes | — | |
| `notes` | `text` | yes | — | Внутренние заметки операторов |
| `created_at` | `timestamptz` | no | `now()` | |
| `updated_at` | `timestamptz` | no | `now()` | обновлять триггером или в коде |

**Индексы:**
- `UNIQUE (telegram_id)` WHERE NOT NULL
- `UNIQUE (web_session_id)` WHERE NOT NULL

**Инвариант:** хотя бы одно из `telegram_id` или `web_session_id` должно быть заполнено (CHECK constraint).

### `staff` — операторы, супервизоры, админы

| Колонка | Тип | Nullable | Комментарий |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `auth_user_id` | `uuid` | yes | FK → `auth.users.id` (Supabase Auth) |
| `email` | `text` | no | UNIQUE |
| `display_name` | `text` | no | |
| `role` | `staff_role` | no | default `'operator'` |
| `telegram_id` | `text` | yes | для личных уведомлений |
| `is_active` | `boolean` | no | default `true` |
| `created_at` | `timestamptz` | no | default `now()` |

### `services` — каталог подписок

| Колонка | Тип | Nullable | Комментарий |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `slug` | `text` | no | UNIQUE, напр. `claude-pro`, `netflix-premium` |
| `name` | `text` | no | Отображаемое |
| `description` | `text` | yes | |
| `category` | `text` | yes | `ai`, `streaming`, `travel`, `productivity`, `other` |
| `requires_kyc` | `boolean` | no | default `false` |
| `pricing_policy` | `jsonb` | yes | см. ниже |
| `is_active` | `boolean` | no | default `true` |
| `created_at` | `timestamptz` | no | default `now()` |

`pricing_policy` shape:
```json
{
  "tiers": [
    { "name": "Pro", "period": "month", "priceRub": 249900, "originalAmount": 2000, "currency": "USD" }
  ],
  "margin": 0.15
}
```
Все цены в копейках/центах (integer).

### `conversations` — треды диалогов

| Колонка | Тип | Nullable | Комментарий |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `user_id` | `uuid` | no | FK → `users.id` ON DELETE CASCADE |
| `channel` | `user_channel` | no | |
| `handoff_mode` | `handoff_mode` | no | default `'ai'` |
| `assigned_operator_id` | `uuid` | yes | FK → `staff.id` |
| `telegram_topic_id` | `integer` | yes | id форум-топика в TG-группе |
| `created_at` | `timestamptz` | no | default `now()` |
| `updated_at` | `timestamptz` | no | default `now()` |

**Индексы:** `user_id`, `assigned_operator_id`.

### `messages` — сообщения в диалогах

| Колонка | Тип | Nullable | Комментарий |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `conversation_id` | `uuid` | no | FK → `conversations.id` ON DELETE CASCADE |
| `role` | `message_role` | no | |
| `staff_id` | `uuid` | yes | FK → `staff.id`, если role=operator |
| `content` | `text` | no | |
| `meta` | `jsonb` | yes | tool_calls, token_usage, finish_reason |
| `created_at` | `timestamptz` | no | default `now()` |

**Индекс:** `(conversation_id, created_at)`.

### `orders` — заказы

| Колонка | Тип | Nullable | Комментарий |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `short_id` | `text` | no | UNIQUE, напр. `ORD-7KX42` |
| `user_id` | `uuid` | no | FK → `users.id` ON DELETE RESTRICT |
| `conversation_id` | `uuid` | yes | FK → `conversations.id` |
| `service_id` | `uuid` | yes | FK → `services.id` (NULL для custom) |
| `custom_service_description` | `text` | yes | для заказов без каталога |
| `status` | `order_status` | no | default `'draft'` |
| `amount_rub` | `integer` | yes | копейки |
| `original_amount` | `integer` | yes | в минимальных единицах оригинальной валюты |
| `original_currency` | `text` | yes | ISO 4217 |
| `requires_kyc` | `boolean` | no | default `false` |
| `kyc_completed_at` | `timestamptz` | yes | |
| `assigned_operator_id` | `uuid` | yes | FK → `staff.id` |
| `supervisor_id` | `uuid` | yes | FK → `staff.id` |
| `parameters` | `jsonb` | yes | структура см. ниже |
| `created_at` | `timestamptz` | no | default `now()` |
| `paid_at` | `timestamptz` | yes | |
| `fulfilled_at` | `timestamptz` | yes | |
| `cancelled_at` | `timestamptz` | yes | |
| `refunded_at` | `timestamptz` | yes | |

`parameters` shape:
```json
{
  "serviceSlug": "claude-pro",
  "tierName": "Pro",
  "period": "month",
  "accountEmail": "user@example.com",
  "region": "US",
  "extra": {}
}
```

**Индексы:** `status`, `user_id`, `assigned_operator_id`.

**CHECK:** `service_id IS NOT NULL OR custom_service_description IS NOT NULL`.

### `order_events` — audit log (append-only)

| Колонка | Тип | Nullable | Комментарий |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `order_id` | `uuid` | no | FK → `orders.id` ON DELETE CASCADE |
| `actor_type` | `actor_type` | no | |
| `actor_id` | `uuid` | yes | `users.id` или `staff.id`, зависит от actor_type |
| `event_type` | `text` | no | `status_changed`, `payment_succeeded`, `assigned`, `note_added`, etc. |
| `from_status` | `order_status` | yes | |
| `to_status` | `order_status` | yes | |
| `payload` | `jsonb` | yes | свободные данные события |
| `created_at` | `timestamptz` | no | default `now()` |

**Индекс:** `(order_id, created_at)`.

**Правило:** только INSERT. Никаких UPDATE/DELETE. Enforced через RLS policy (отказ на UPDATE для всех ролей кроме миграций).

### `payments` — платёжные попытки

| Колонка | Тип | Nullable | Комментарий |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `order_id` | `uuid` | no | FK → `orders.id` ON DELETE RESTRICT |
| `provider` | `payment_provider` | no | |
| `provider_ref` | `text` | no | id платежа у провайдера |
| `amount_rub` | `integer` | no | копейки |
| `status` | `payment_status` | no | default `'pending'` |
| `raw_payload` | `jsonb` | yes | последний webhook raw body |
| `created_at` | `timestamptz` | no | default `now()` |
| `completed_at` | `timestamptz` | yes | |

**Индексы:**
- `UNIQUE (provider, provider_ref)` — **идемпотентность**
- `order_id`

### `attachments` — файлы в Supabase Storage

| Колонка | Тип | Nullable | Комментарий |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `order_id` | `uuid` | yes | FK → `orders.id` ON DELETE SET NULL |
| `message_id` | `uuid` | yes | FK → `messages.id` ON DELETE SET NULL |
| `kind` | `attachment_kind` | no | |
| `storage_path` | `text` | no | путь в bucket |
| `mime_type` | `text` | yes | |
| `size_bytes` | `integer` | yes | |
| `uploaded_by` | `uuid` | yes | `users.id` или `staff.id` |
| `created_at` | `timestamptz` | no | default `now()` |

## Row Level Security

RLS **включён** на всех таблицах кроме `services` (публичный каталог, чтение без auth допустимо).

### Принципы
- Клиентский код (`apps/web`) использует **anon key** + user JWT для админки (Supabase Auth для staff)
- Webhook/бот/агент используют **service_role key** в server-only контексте — **никогда не передавать в браузер**
- Для клиентов (users) JWT не применяется — их операции идут через server-side код с service_role

### Политики (пример для admin)

```sql
-- staff может видеть себя
CREATE POLICY "staff_self_read" ON staff
  FOR SELECT USING (auth_user_id = auth.uid());

-- admin видит всех
CREATE POLICY "admin_full_staff" ON staff
  FOR ALL USING (
    EXISTS (SELECT 1 FROM staff WHERE auth_user_id = auth.uid() AND role = 'admin')
  );

-- operator видит только свои orders
CREATE POLICY "operator_own_orders" ON orders
  FOR SELECT USING (
    assigned_operator_id = (SELECT id FROM staff WHERE auth_user_id = auth.uid())
  );

-- supervisor/admin видят всё
CREATE POLICY "supervisor_all_orders" ON orders
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM staff WHERE auth_user_id = auth.uid() AND role IN ('supervisor', 'admin'))
  );

-- operator может менять status только с paid на in_fulfillment/completed/failed
CREATE POLICY "operator_fulfill" ON orders
  FOR UPDATE USING (
    assigned_operator_id = (SELECT id FROM staff WHERE auth_user_id = auth.uid())
  );

-- order_events: никто не апдейтит
CREATE POLICY "order_events_readonly_update" ON order_events
  FOR UPDATE USING (false);

CREATE POLICY "order_events_readonly_delete" ON order_events
  FOR DELETE USING (false);
```

Полный набор политик — в миграциях при реализации Sprint 2.

## Миграционная стратегия

- Все изменения схемы — через Drizzle migrations (`drizzle-kit generate` → commit файла → `db:push`)
- Миграции коммитятся в репо в `packages/db/migrations/`
- **Никогда не править applied-миграцию** — только новая
- Destructive migrations (drop column) — разрешено только после явного согласования владельца

## Расширения PostgreSQL

- `pgcrypto` — для `gen_random_uuid()` (включается автоматически в Supabase)
- `pg_cron` — не использовать, для cron есть Trigger.dev
- `pg_net` — не использовать на MVP
