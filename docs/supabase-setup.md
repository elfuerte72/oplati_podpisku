# Supabase setup

## Создание проекта

1. https://supabase.com/dashboard → New project
2. **Region**: `eu-central-1` (Frankfurt) — ближайший к РФ пользователям
3. **Database password**: сгенерировать и сохранить в менеджере паролей (нужен будет для `DATABASE_URL_DIRECT`)
4. **Pricing tier**: Free на dev, Pro ($25/мес) при продакшне

## Подключения

Две строки подключения:

### `DATABASE_URL` — транзакционный pooler (для рантайма приложения)

```
postgresql://postgres.{{PROJECT_REF}}:{{PASSWORD}}@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
```

Параметр `?pgbouncer=true` важен. Драйвер `postgres-js` использовать с `prepare: false`.

### `DATABASE_URL_DIRECT` — direct connection (для миграций)

```
postgresql://postgres.{{PROJECT_REF}}:{{PASSWORD}}@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
```

Используется `drizzle-kit` и ручными SQL-скриптами.

## Получение API keys

Dashboard → Project Settings → API:
- `SUPABASE_URL` = Project URL
- `SUPABASE_ANON_KEY` = anon (public) — можно в браузер
- `SUPABASE_SERVICE_ROLE_KEY` = service_role — **только server-side**, никогда не отдавать в клиент

## Расширения

Включаются через SQL Editor или Dashboard → Database → Extensions:

| Расширение | Зачем | Включить |
|---|---|---|
| `pgcrypto` | `gen_random_uuid()` | автоматически |
| `uuid-ossp` | legacy, не нужен | нет |
| `pg_stat_statements` | observability | да |

## Storage buckets

Dashboard → Storage → Create bucket:

| Bucket | Public | Назначение |
|---|---|---|
| `payment-proofs` | `private` | скриншоты оплаты от операторов |
| `fulfillment-proofs` | `private` | доказательства выполнения заказа |
| `kyc-documents` | `private` | KYC-документы клиентов |

**RLS на Storage:**

```sql
-- Только server (service_role) пишет в kyc-documents
CREATE POLICY "kyc_insert_service_only" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (false);  -- запрет для клиентов; service_role обходит RLS

-- Операторы могут читать fulfillment-proofs только для своих заказов
CREATE POLICY "operator_read_fulfillment" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'fulfillment-proofs' AND
    EXISTS (
      SELECT 1 FROM orders o
      JOIN staff s ON s.auth_user_id = auth.uid()
      WHERE o.id::text = split_part(storage.objects.name, '/', 1)
        AND (o.assigned_operator_id = s.id OR s.role IN ('supervisor', 'admin'))
    )
  );
```

Конвенция пути: `{{bucket}}/{{order_id}}/{{uuid}}.{{ext}}`.

## Auth

Dashboard → Authentication → Providers:

**Для MVP (Sprint 2):**
- Email + password — для staff
- Magic link — опционально (удобнее, но требует SMTP)

**Настройка:**
- Site URL: `https://oplati.example.com`
- Redirect URLs: `https://oplati.example.com/admin/callback`, `http://localhost:3000/admin/callback`
- Disable public signup (Authentication → Policies → Email → Disable signup) — добавлять staff только через invite

**Invite flow для staff:**
1. Admin вручную создаёт запись в `staff` с ролью
2. Dashboard → Authentication → Users → Invite user (email)
3. После регистрации — триггер обновляет `staff.auth_user_id = auth.uid()` по совпадению email

## RLS — включить на всех таблицах

Базовая команда (выполнить для каждой):

```sql
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
-- services: публичный каталог — RLS НЕ включать
```

Полный набор политик — см. `database.md`.

## Realtime

Dashboard → Database → Replication → Source=supabase_realtime:
- Включить публикацию для `orders` и `messages`
- В админке подписка: `supabase.channel('orders').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, handler).subscribe()`

## Backups и PITR

Free tier — 7 дней автоматических daily backups.
Pro tier — PITR (Point-in-Time Recovery) до 7 дней. Включить при продакшне.

## Monitoring

Dashboard → Reports: запросы, latency, размер БД. Алерты настраиваются в Dashboard → Project Settings → Integrations.

## Что НЕ делать

- Не хранить `SUPABASE_SERVICE_ROLE_KEY` в клиентском коде — только server-only env
- Не выключать RLS «чтобы быстрее» — включить сразу, писать политики по мере
- Не использовать `auth.users` таблицу напрямую — только через `staff.auth_user_id` в связке
- Не изменять схему через Dashboard SQL Editor вручную — только Drizzle migrations
