# Plan — Расширение схемы БД (`services`, `orders`, `order_events`, `payments`, `attachments`) + seed каталога

- **Branch:** `feature/db-extended-schema`
- **Created:** 2026-05-15
- **Plan author:** Claude Opus 4.7 (через `/aif-plan full`)

## Settings

- **Testing:** нет — чистая инфра-milestone (schema + seed). Smoke-проверка через Supabase MCP (`list_tables`, `execute_sql` с positive/negative inserts), как в предыдущем milestone «Базовая схема БД». Vitest пока не bootstrapped в `@oplati/db`.
- **Logging:** стандартное. `drizzle-kit verbose=true` уже включён в `drizzle.config.ts` (SQL миграций в stdout). Seed-скрипт логирует через pino `logger.info` каждую вставленную услугу (slug + название + tier count). DDL `.sql` коммитятся в репо как audit trail.
- **Docs update:** не требуется — `docs/database.md` уже описывает финальную схему всех 5 таблиц. Расхождений после имплементации быть не должно; при появлении — правим код, не docs (CLAUDE.md golden rule). `.ai-factory/Journal/` обновим в `/aif-verify`.

## Roadmap Linkage

- **Milestone:** «Расширение схемы БД» (`.ai-factory/ROADMAP.md` строка 14).
- **Rationale:** план реализует ровно DoD этого milestone — `services`, `orders`, `payments`, `attachments`, `order_events` в Drizzle + seed каталога 10 услуг (Claude, ChatGPT, Netflix, Spotify, Airbnb, YouTube Premium, Discord Nitro, Midjourney, LinkedIn Premium, Apple) с правильным `requires_kyc`. Таблица `staff` уже применена в предыдущем milestone.
- **Sprint roadmap correspondence:** `docs/roadmap.md` Sprint 2, первый пункт — «Расширение схемы: services, orders, payments, attachments, order_events + seed каталога».

## Контекст и решения

### Текущее состояние

- `packages/db/src/schema.ts` (120 строк) — содержит **только** базовые 4 таблицы: `users`, `staff`, `conversations`, `messages` + 4 enum'а (`user_channel`, `staff_role`, `handoff_mode`, `message_role`). Применено в Supabase `nyxijwpuvctmvemaemqn` после milestone «Базовая схема БД».
- `packages/types/src/index.ts` — уже определены zod-схемы `orderStatus`, `orderParameters`, `serviceTier`, `pricingPolicy`, `paymentWebhookEvent`. **Дублируются** в БД-enum'ы в этом milestone: `order_status` уже в TS-енумах, но в БД его пока нет.
- `packages/db/drizzle/` (по docs/database.md `migrations`, в реальности `drizzle/` per drizzle.config.ts default) — есть `0000_*.sql` (base schema) + `0001_enable_rls.sql` (custom).
- Supabase: 4 базовых таблицы + RLS включён на всех 4. `pgcrypto` доступен.
- `apps/web/lib/repositories.ts` (по contemporary имени из CLAUDE.md `getOrCreateUserByTelegramId`/`getOrCreateActiveConversation`/`appendMessage`) — импортирует только текущие таблицы, не сломается.

### Решения по scope (зафиксированы preferences)

1. **5 таблиц + 5 enum'ов сразу в одной auto-migration.** `services`, `orders`, `order_events`, `payments`, `attachments` + enums `order_status`, `payment_provider`, `payment_status`, `attachment_kind`, `actor_type`. FK на уже существующие `users`/`staff`/`conversations`/`messages` присутствуют. Зависимостей нет, единый diff Drizzle применит атомарно.
2. **Repository-функции — следующий milestone** «State machine + AI tools». Здесь только DDL + seed. Это согласовано: в предыдущем milestone (Base schema) тоже сначала DDL, потом отдельным milestone repos (Preview-деплой → `getOrCreateUserByTelegramId`).
3. **Seed через TS-скрипт** `packages/db/scripts/seed-catalog.ts` + `pnpm --filter @oplati/db db:seed`. Идемпотентный UPSERT по `slug` (`INSERT ... ON CONFLICT (slug) DO UPDATE SET ...`). Преимущество перед data-migration: правка цен не требует новой миграции, а перезапуск seed безопасен.
4. **RLS:** только `ENABLE ROW LEVEL SECURITY` на `orders`, `order_events`, `payments`, `attachments`. `services` **БЕЗ** RLS — публичный каталог, чтение анонимом допустимо (docs/database.md явно: «RLS включён на всех таблицах кроме `services`»). Политики (operator_own_orders, supervisor_all_orders, order_events_readonly_*) — milestone «Минимальная админка».
5. **Append-only `order_events` enforcement.** В этом milestone — только структура + ENABLE RLS. Реальный append-only enforcement (DENY UPDATE/DELETE через policy + revoke BYPASSRLS для service_role) — отдельный шаг в milestone «State machine + AI tools», где появляется `transitionOrder()` и потребуется доказать инвариант в коде. Сейчас инвариант **держится конвенцией кода**, не DB-уровнем (как в base-schema milestone).
6. **Цены — placeholder** на основе известных USD-прайсов сервисов + курс ~95₽/USD + margin 15%. В коде seed-скрипта помечено комментарием `TODO: верифицировать с владельцем перед production` + ссылка на этот план.
7. **short_id (`ORD-XXXXX`)** — генерация **в коде** repository-функций (следующий milestone). В этом milestone колонка `NOT NULL UNIQUE` без DB-default. Seed в `orders` не делаем, так что отсутствие генератора пока не блокирует.

### Расхождения schema.ts ↔ docs/database.md, которые правим в этом milestone

| Что | В schema.ts сейчас | По docs/database.md | План |
|---|---|---|---|
| `services` таблица | отсутствует | полная схема + `pricing_policy` jsonb | добавить |
| `orders` таблица | отсутствует | полная схема + CHECK + индексы | добавить |
| `order_events` таблица | отсутствует | append-only + индекс (order_id, created_at) | добавить |
| `payments` таблица | отсутствует | UNIQUE(provider, provider_ref) | добавить |
| `attachments` таблица | отсутствует | FK с ON DELETE SET NULL | добавить |
| enum `order_status` | отсутствует | 13 значений | добавить, синхронизировать со списком в `@oplati/types` |
| enum `payment_provider` | отсутствует | 4 значения | добавить |
| enum `payment_status` | отсутствует | 4 значения | добавить |
| enum `attachment_kind` | отсутствует | 4 значения | добавить |
| enum `actor_type` | отсутствует | 6 значений | добавить |

### Поток применения миграций

Как в предыдущем milestone:

1. **DDL для таблиц/enum/индексов/CHECK/FK** — `db:generate` создаёт `0002_*.sql` (audit trail в git) → `db:push` применяет diff из schema.ts.
2. **RLS** — кастомная миграция `0003_enable_rls_extended.sql` (через `drizzle-kit generate --custom`) → применить через **Supabase MCP `apply_migration`** (запишется в `supabase_migrations.schema_migrations`).
3. **Seed** — `pnpm --filter @oplati/db db:seed` запускает `tsx scripts/seed-catalog.ts`, использует `DATABASE_URL_DIRECT` из `.env.local`.

### Архитектурные инварианты, которые проверяем в Verification

По CLAUDE.md «Архитектурные инварианты»:

1. **`order_events` append-only** — структурно готово (FK CASCADE на orders), enforcement-политика придёт в state-machine milestone. Сейчас проверяем: INSERT работает.
2. **Идемпотентность платежей** — `UNIQUE(provider, provider_ref)` на `payments`. Verify: повторный INSERT с теми же `(provider, provider_ref)` падает с `23505 unique_violation`.
3. **Деньги в копейках** — `amount_rub integer`, `original_amount integer`. Verify: типы в `pg_attribute`.
4. **State-переходы только через `transitionOrder()`** — N/A, функции ещё нет (следующий milestone).
5. **Zod на границах** — для seed используем `pricingPolicy.parse()` перед INSERT, гарантируя структурную валидность `pricing_policy` jsonb.
6. **CHECK constraint `orders`:** `service_id IS NOT NULL OR custom_service_description IS NOT NULL` — verify negative insert падает.

## Tasks

### Phase 1 — Types & Enums

#### Task 1: Расширить `@oplati/types` enum-схемами ✅
- **Файл:** `packages/types/src/index.ts`
- **Добавить zod enums** (если ещё нет — `orderStatus` уже есть):
  ```ts
  export const paymentProvider = z.enum(['yookassa', 'cryptobot', 'sbp', 'manual']);
  export type PaymentProvider = z.infer<typeof paymentProvider>;

  export const paymentStatus = z.enum(['pending', 'succeeded', 'failed', 'refunded']);
  export type PaymentStatus = z.infer<typeof paymentStatus>;

  export const attachmentKind = z.enum(['payment_proof', 'kyc', 'fulfillment_proof', 'other']);
  export type AttachmentKind = z.infer<typeof attachmentKind>;

  export const actorType = z.enum(['system', 'user', 'operator', 'supervisor', 'ai', 'payment_provider']);
  export type ActorType = z.infer<typeof actorType>;
  ```
- **Проверить:** существующий `paymentWebhookEvent.provider` уже использует литералы — заменить на `provider: paymentProvider` где это не сломает совместимость. Если ломает — оставить inline для webhook envelope (внешний контракт), а в БД использовать новый enum.
- **Логирование:** N/A (compile-time).

#### Task 2: Расширить `packages/db/src/schema.ts` enum-определениями ✅
- **Файл:** `packages/db/src/schema.ts`
- **Добавить после существующих enum'ов:**
  ```ts
  export const orderStatusEnum = pgEnum('order_status', [
    'draft', 'clarifying', 'kyc_required', 'ready_for_payment', 'pending_payment',
    'paid', 'in_fulfillment', 'completed', 'failed', 'cancelled', 'expired',
    'refund_requested', 'refunded',
  ]);
  export const paymentProviderEnum = pgEnum('payment_provider', ['yookassa', 'cryptobot', 'sbp', 'manual']);
  export const paymentStatusEnum = pgEnum('payment_status', ['pending', 'succeeded', 'failed', 'refunded']);
  export const attachmentKindEnum = pgEnum('attachment_kind', ['payment_proof', 'kyc', 'fulfillment_proof', 'other']);
  export const actorTypeEnum = pgEnum('actor_type', ['system', 'user', 'operator', 'supervisor', 'ai', 'payment_provider']);
  ```
- **Sync check:** литералы должны побайтово совпадать с `@oplati/types` (Task 1) — Drizzle не контролирует это автоматически.
- **Логирование:** N/A.

### Phase 2 — Tables

#### Task 3: Добавить таблицу `services` в `schema.ts` ✅
- **Файл:** `packages/db/src/schema.ts`
- **Структура** (точно по docs/database.md):
  ```ts
  export const services = pgTable('services', {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category'), // 'ai' | 'streaming' | 'travel' | 'productivity' | 'other'
    requiresKyc: boolean('requires_kyc').default(false).notNull(),
    pricingPolicy: jsonb('pricing_policy').$type<import('@oplati/types').PricingPolicy>(),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  });
  // БЕЗ .enableRLS() — публичный каталог по docs/database.md
  ```
- **Импорт:** `import type { PricingPolicy } from '@oplati/types';` (типизация jsonb, runtime валидация в repos/seed).
- **Логирование:** N/A.

#### Task 4: Добавить таблицу `orders` + CHECK constraint ✅
- **Файл:** `packages/db/src/schema.ts`
- **Структура:**
  ```ts
  export const orders = pgTable(
    'orders',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      shortId: text('short_id').notNull().unique(), // 'ORD-7KX42', генерируется в коде
      userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
      conversationId: uuid('conversation_id').references(() => conversations.id),
      serviceId: uuid('service_id').references(() => services.id),
      customServiceDescription: text('custom_service_description'),
      status: orderStatusEnum('status').default('draft').notNull(),
      amountRub: integer('amount_rub'), // копейки
      originalAmount: integer('original_amount'),
      originalCurrency: text('original_currency'),
      requiresKyc: boolean('requires_kyc').default(false).notNull(),
      kycCompletedAt: timestamp('kyc_completed_at', { withTimezone: true }),
      assignedOperatorId: uuid('assigned_operator_id').references(() => staff.id),
      supervisorId: uuid('supervisor_id').references(() => staff.id),
      parameters: jsonb('parameters').$type<import('@oplati/types').OrderParameters>(),
      createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
      paidAt: timestamp('paid_at', { withTimezone: true }),
      fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
      cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
      refundedAt: timestamp('refunded_at', { withTimezone: true }),
    },
    (t) => ({
      statusIdx: index('orders_status_idx').on(t.status),
      userIdx: index('orders_user_id_idx').on(t.userId),
      operatorIdx: index('orders_operator_id_idx').on(t.assignedOperatorId),
      serviceOrCustom: check(
        'orders_service_or_custom',
        sql`${t.serviceId} IS NOT NULL OR ${t.customServiceDescription} IS NOT NULL`,
      ),
    }),
  ).enableRLS();
  ```
- **Импорт:** `OrderParameters` из `@oplati/types`.
- **Логирование:** N/A.

#### Task 5: Добавить таблицу `order_events` (append-only audit log) ✅
- **Файл:** `packages/db/src/schema.ts`
- **Структура:**
  ```ts
  export const orderEvents = pgTable(
    'order_events',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      orderId: uuid('order_id')
        .notNull()
        .references(() => orders.id, { onDelete: 'cascade' }),
      actorType: actorTypeEnum('actor_type').notNull(),
      actorId: uuid('actor_id'), // полиморфный — users.id или staff.id; FK не ставим
      eventType: text('event_type').notNull(), // 'status_changed' | 'payment_succeeded' | etc.
      fromStatus: orderStatusEnum('from_status'),
      toStatus: orderStatusEnum('to_status'),
      payload: jsonb('payload').$type<Record<string, unknown>>(),
      createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (t) => ({
      orderTimeIdx: index('order_events_order_id_created_at_idx').on(t.orderId, t.createdAt),
    }),
  ).enableRLS();
  ```
- **Note:** `actor_id` без FK — полиморфная ссылка (users или staff). По docs/database.md так и должно быть.
- **Логирование:** N/A.

#### Task 6: Добавить таблицу `payments` с UNIQUE(provider, provider_ref) ✅
- **Файл:** `packages/db/src/schema.ts`
- **Структура:**
  ```ts
  export const payments = pgTable(
    'payments',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      orderId: uuid('order_id')
        .notNull()
        .references(() => orders.id, { onDelete: 'restrict' }),
      provider: paymentProviderEnum('provider').notNull(),
      providerRef: text('provider_ref').notNull(),
      amountRub: integer('amount_rub').notNull(), // копейки
      status: paymentStatusEnum('status').default('pending').notNull(),
      rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>(),
      createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
      completedAt: timestamp('completed_at', { withTimezone: true }),
    },
    (t) => ({
      providerRefIdx: uniqueIndex('payments_provider_provider_ref_idx').on(t.provider, t.providerRef),
      orderIdx: index('payments_order_id_idx').on(t.orderId),
    }),
  ).enableRLS();
  ```
- **Инвариант:** `UNIQUE(provider, provider_ref)` — основа идемпотентности webhook'ов (CLAUDE.md).
- **Логирование:** N/A.

#### Task 7: Добавить таблицу `attachments` (Supabase Storage refs) ✅
- **Файл:** `packages/db/src/schema.ts`
- **Структура:**
  ```ts
  export const attachments = pgTable('attachments', {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    kind: attachmentKindEnum('kind').notNull(),
    storagePath: text('storage_path').notNull(),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    uploadedBy: uuid('uploaded_by'), // полиморфный — users.id или staff.id
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  }).enableRLS();
  ```
- **Note:** `ON DELETE SET NULL` для обеих FK — файлы переживают удаление order/message (если такое случится в admin tooling).
- **Логирование:** N/A.

### Phase 3 — Migrations

#### Task 8: Сгенерировать auto-migration через `db:generate` ✅ (создан `0003_common_richard_fisk.sql`)
- **Команда:** `pnpm --filter @oplati/db db:generate`
- **Ожидание:** `packages/db/drizzle/0002_<name>.sql` + обновление `packages/db/drizzle/meta/_journal.json`.
- **Verify в `.sql` вручную:**
  - `CREATE TYPE public.order_status AS ENUM (13 values);` и аналогично для остальных 4 enum'ов.
  - `CREATE TABLE services (...)`, без `ENABLE ROW LEVEL SECURITY` (т.к. `.enableRLS()` не вызван).
  - `CREATE TABLE orders (...) CHECK (service_id IS NOT NULL OR custom_service_description IS NOT NULL)` (как column-level или table-level CHECK — оба варианта приемлемы).
  - FK: `orders.user_id ... ON DELETE RESTRICT`, `order_events.order_id ... ON DELETE CASCADE`, `payments.order_id ... ON DELETE RESTRICT`, `attachments.order_id/message_id ... ON DELETE SET NULL`.
  - `CREATE UNIQUE INDEX payments_provider_provider_ref_idx ON payments (provider, provider_ref);`
  - 4 таблицы с ENABLE RLS (orders, order_events, payments, attachments) — это **НЕ** будет в `.sql`; Drizzle .enableRLS() пишет это в отдельный шаг diff. Если не пишет — переносим в Task 9 (custom migration).
- **Если drizzle-kit спросит интерактивно про destructive changes** — отвечать **No** (схема расширяется, ничего не удаляется).
- **Логирование:** drizzle-kit `verbose=true` уже в `drizzle.config.ts` — SQL в stdout.

#### Task 9: Создать custom migration `0003_enable_rls_extended.sql` ⏭️ SKIPPED — `.enableRLS()` уже эмитировал `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` в `0003_common_richard_fisk.sql` (см. строки 18, 31, 57, 70). Task 13 тоже становится no-op.
- **Команда:** `pnpm --filter @oplati/db exec drizzle-kit generate --custom --name=enable_rls_extended`
- **Файл:** `packages/db/drizzle/0003_enable_rls_extended.sql` (заполнить руками).
- **Содержимое:**
  ```sql
  -- ENABLE RLS для новых таблиц с пользовательскими данными.
  -- services БЕЗ RLS — публичный каталог (docs/database.md).
  -- Политики (operator_own_orders, supervisor_all_orders, order_events_readonly_*)
  -- появятся в milestone "Минимальная админка". service_role пока обходит RLS —
  -- server-only код продолжит работать.
  ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "order_events" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;
  ```
- **Если Task 8 уже включил `ENABLE ROW LEVEL SECURITY` через `.enableRLS()` в auto-migration** — этот файл становится no-op или удаляется. Решение принимается после inspect 0002_*.sql.
- **Логирование:** SQL в git.

### Phase 4 — Seed catalog

#### Task 10: Создать `packages/db/scripts/seed-catalog.ts` ✅
- **Файл:** `packages/db/scripts/seed-catalog.ts` (новый, создать `scripts/` директорию).
- **Зависимости:** `postgres`, `drizzle-orm`, `@oplati/types` (`pricingPolicy.parse`), `pino`. Если pino отсутствует в `@oplati/db` — добавить как devDependency или использовать `console.log` (только в скрипте, не в runtime). **Решение:** использовать pino (уже в monorepo).
- **Структура:**
  ```ts
  import 'dotenv/config';
  import postgres from 'postgres';
  import { drizzle } from 'drizzle-orm/postgres-js';
  import { sql } from 'drizzle-orm';
  import { services } from '../src/schema.ts';
  import { pricingPolicy, type PricingPolicy } from '@oplati/types';
  import pino from 'pino';

  const logger = pino({ name: 'seed-catalog' });

  // TODO: верифицировать цены с владельцем перед production.
  // Placeholder: USD-прайс × курс ~95₽ × margin 15%.
  const CATALOG = [
    {
      slug: 'claude-pro',
      name: 'Claude Pro',
      description: 'AI-ассистент от Anthropic',
      category: 'ai',
      requiresKyc: false,
      pricingPolicy: {
        tiers: [{ name: 'Pro', period: 'month' as const, priceRub: 253000, originalAmount: 2000, currency: 'USD' }],
        margin: 0.15,
      },
    },
    { slug: 'chatgpt-plus', name: 'ChatGPT Plus', category: 'ai', requiresKyc: false,
      pricingPolicy: { tiers: [{ name: 'Plus', period: 'month' as const, priceRub: 253000, originalAmount: 2000, currency: 'USD' }], margin: 0.15 } },
    { slug: 'netflix-premium', name: 'Netflix Premium', category: 'streaming', requiresKyc: false,
      pricingPolicy: { tiers: [{ name: 'Premium', period: 'month' as const, priceRub: 290800, originalAmount: 2299, currency: 'USD' }], margin: 0.15 } },
    { slug: 'spotify-premium', name: 'Spotify Premium', category: 'streaming', requiresKyc: false,
      pricingPolicy: { tiers: [{ name: 'Individual', period: 'month' as const, priceRub: 139100, originalAmount: 1099, currency: 'USD' }], margin: 0.15 } },
    { slug: 'airbnb', name: 'Airbnb (бронирование)', category: 'travel', requiresKyc: true,
      pricingPolicy: { tiers: [], margin: 0.15 } /* кастомные суммы под каждый заказ */ },
    { slug: 'youtube-premium', name: 'YouTube Premium', category: 'streaming', requiresKyc: false,
      pricingPolicy: { tiers: [{ name: 'Individual', period: 'month' as const, priceRub: 177100, originalAmount: 1399, currency: 'USD' }], margin: 0.15 } },
    { slug: 'discord-nitro', name: 'Discord Nitro', category: 'productivity', requiresKyc: false,
      pricingPolicy: { tiers: [{ name: 'Nitro', period: 'month' as const, priceRub: 126500, originalAmount: 999, currency: 'USD' }], margin: 0.15 } },
    { slug: 'midjourney-basic', name: 'Midjourney Basic', category: 'ai', requiresKyc: false,
      pricingPolicy: { tiers: [{ name: 'Basic', period: 'month' as const, priceRub: 126500, originalAmount: 1000, currency: 'USD' }], margin: 0.15 } },
    { slug: 'linkedin-premium', name: 'LinkedIn Premium', category: 'productivity', requiresKyc: true,
      pricingPolicy: { tiers: [{ name: 'Career', period: 'month' as const, priceRub: 379500, originalAmount: 2999, currency: 'USD' }], margin: 0.15 } },
    { slug: 'apple-one', name: 'Apple One', category: 'productivity', requiresKyc: true,
      pricingPolicy: { tiers: [{ name: 'Individual', period: 'month' as const, priceRub: 253000, originalAmount: 1995, currency: 'USD' }], margin: 0.15 } },
  ] as const;

  async function main() {
    const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL_DIRECT or DATABASE_URL must be set');
    const client = postgres(url, { max: 1 });
    const db = drizzle(client);
    try {
      for (const entry of CATALOG) {
        // Runtime-валидация структуры pricing_policy (инвариант: Zod на границах).
        const validatedPolicy: PricingPolicy = pricingPolicy.parse(entry.pricingPolicy);
        await db.insert(services).values({
          slug: entry.slug,
          name: entry.name,
          description: entry.description ?? null,
          category: entry.category,
          requiresKyc: entry.requiresKyc,
          pricingPolicy: validatedPolicy,
          isActive: true,
        }).onConflictDoUpdate({
          target: services.slug,
          set: {
            name: entry.name,
            description: entry.description ?? null,
            category: entry.category,
            requiresKyc: entry.requiresKyc,
            pricingPolicy: validatedPolicy,
            isActive: true,
          },
        });
        logger.info({ slug: entry.slug, name: entry.name, tiers: validatedPolicy.tiers.length }, 'service seeded');
      }
      logger.info({ count: CATALOG.length }, 'catalog seed complete');
    } finally {
      await client.end({ timeout: 5 });
    }
  }

  main().catch((err) => {
    logger.error({ err }, 'seed failed');
    process.exit(1);
  });
  ```
- **Note:** `Airbnb` — единственная услуга с `tiers: []` (кастомные суммы под каждое бронирование). Pricing policy для Airbnb валидируется отдельно — `pricingPolicy` zod-схема требует `tiers.min(1)`, поэтому **либо** ослабляем zod-схему до `min(0)` (изменение в `@oplati/types`), **либо** даём Airbnb dummy tier с `priceRub: 0` и комментарием «фактическая цена в orders.amount_rub». **Решение:** даём Airbnb tier `{ name: 'Booking', period: 'month', priceRub: 0, originalAmount: 0, currency: 'USD' }` + комментарий в seed-скрипте; никаких правок в @oplati/types.
- **Логирование:** pino INFO на каждую вставленную услугу + summary.

#### Task 11: Добавить script `db:seed` в `packages/db/package.json` ✅
- **Файл:** `packages/db/package.json`
- **Добавить в `"scripts"`:**
  ```json
  "db:seed": "tsx scripts/seed-catalog.ts"
  ```
- **Devdeps:** проверить, что `tsx` уже есть (используется для drizzle-kit) — иначе `pnpm add -D tsx` в `packages/db`. `pino` — `pnpm add pino` (если нет).
- **Логирование:** N/A.

### Phase 5 — Apply

#### Task 12: Применить DDL через `db:push` ✅ (через Supabase MCP `apply_migration`, т.к. direct hostname `db.<ref>.supabase.co` не резолвится, а проект Supabase был в авто-паузе → пришлось `restore_project`)
- **Команда:** `pnpm --filter @oplati/db db:push`
- **Использует:** `DATABASE_URL_DIRECT` (порт 5432, не pooler) из `.env`.
- **Защита от data-loss:** drizzle-kit спросит при destructive-changes — отвечать **No** (схема расширяется, существующие данные `users`/`staff`/`conversations`/`messages` не должны быть затронуты).
- **После применения** — `list_tables` через Supabase MCP убедиться, что появились 5 новых таблиц + 5 новых enum'ов.
- **Логирование:** drizzle-kit печатает SQL.

#### Task 13: Применить RLS через Supabase MCP ⏭️ SKIPPED — RLS включён в той же миграции `0003`
- **Инструмент:** `mcp__claude_ai_Supabase__apply_migration`
- **Аргументы:** `project_id=nyxijwpuvctmvemaemqn`, `name=enable_rls_extended`, `query=` содержимое `0003_enable_rls_extended.sql`.
- **Skip if** Task 8 включил `ENABLE ROW LEVEL SECURITY` в auto-migration через `.enableRLS()`.

#### Task 14: Запустить seed каталога ✅
- **Команда:** `pnpm --filter @oplati/db db:seed`
- **Ожидание:** 10 строк INFO от pino — по одной на каждую услугу + финальный summary.
- **Повторный запуск** — должен быть идемпотентным (UPSERT по slug), никаких новых INSERT, только UPDATE.
- **Логирование:** pino stdout.

### Phase 6 — Verification

#### Task 15: Smoke через Supabase MCP ✅ (9 таблиц, 5 enum'ов, RLS на 4 новых, services без RLS, 10 услуг с правильным kyc, CHECK падает, UNIQUE 23505, FK CASCADE order→events работает)
- **Шаги:**
  1. `list_tables(project_id, schemas=['public'], verbose=true)` — присутствуют 9 таблиц: 4 базовые + `services`, `orders`, `order_events`, `payments`, `attachments`.
  2. `execute_sql`: `SELECT typname FROM pg_type WHERE typname IN ('order_status','payment_provider','payment_status','attachment_kind','actor_type') ORDER BY typname;` — 5 строк.
  3. `execute_sql`: `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('services','orders','order_events','payments','attachments') ORDER BY relname;` — `services.relrowsecurity = false`, остальные 4 = `true`.
  4. **Catalog seeded:** `SELECT slug, name, requires_kyc, jsonb_array_length(pricing_policy->'tiers') AS tier_count FROM services ORDER BY slug;` — 10 строк, `airbnb`/`apple-one`/`linkedin-premium` имеют `requires_kyc = true`.
  5. **CHECK invariant** (orders): `INSERT INTO orders (short_id, user_id, status) VALUES ('ORD-TEST1', '<existing-user-uuid>', 'draft');` — должен **упасть** на `orders_service_or_custom` CHECK (нет ни service_id, ни custom_service_description).
  6. **Idempotency (payments):** через `execute_sql`:
     ```sql
     -- сначала надо чтобы был хотя бы один order; создадим временный
     WITH u AS (SELECT id FROM users LIMIT 1),
          o AS (
            INSERT INTO orders (short_id, user_id, custom_service_description, status)
            VALUES ('ORD-TEST2', (SELECT id FROM u), 'test custom', 'draft')
            RETURNING id
          )
     INSERT INTO payments (order_id, provider, provider_ref, amount_rub)
     VALUES ((SELECT id FROM o), 'yookassa', 'test-ref-001', 100000);
     ```
     Затем повторный INSERT с теми же `(provider, provider_ref)` → ошибка `23505`. Cleanup: `DELETE FROM payments WHERE provider_ref = 'test-ref-001'; DELETE FROM orders WHERE short_id IN ('ORD-TEST1','ORD-TEST2');`.
  7. **FK CASCADE на order_events:** создать тестовый order и event, удалить order → event удалён.

#### Task 16: Прогнать typecheck/lint/build ✅
- **Команды (последовательно из корня):**
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm build`
- **Ожидание:** всё зелёное. Особое внимание — `@oplati/db` build (типы новых таблиц должны экспортироваться через barrel `index.ts`).
- **Если новые таблицы не реэкспортируются через `packages/db/src/index.ts`** — добавить (там сейчас `export * from './schema.ts'` — должно покрыть автоматически, но проверить).

#### Task 17: Закрыть milestone в `.ai-factory/ROADMAP.md` ✅
- **Файл:** `.ai-factory/ROADMAP.md`
- **Правки:**
  - Строка 14: `- [ ]` → `- [x]` для «Расширение схемы БД».
  - Таблица Completed: добавить `| Расширение схемы БД | 2026-05-15 |`.
- Это финальный шаг перед коммитом, выполняется в `/aif-verify`.

## Commit Plan

5 коммитов, сгруппированных логически:

| Commit | После задач | Сообщение |
|---|---|---|
| 1 | 1 + 2 | `feat(types,db): add enums for orders/payments/attachments/actors` |
| 2 | 3 + 4 + 5 + 6 + 7 | `feat(db): add services, orders, order_events, payments, attachments tables` |
| 3 | 8 + 9 | `feat(db): generate extended-schema migration + enable_rls_extended` |
| 4 | 10 + 11 | `feat(db): catalog seed script with 10 services (placeholder pricing)` |
| 5 | 12 + 13 + 14 + 15 + 16 + 17 | `chore(db): apply extended schema, RLS, seed catalog; close milestone` |

Conventional Commits, ≤72 символа в заголовке (по `docs/coding-standards.md`).

## Definition of Done (этот milestone)

- [ ] `packages/db/src/schema.ts` содержит 9 таблиц (4 базовые + 5 новых) и 9 enum'ов (4 базовых + 5 новых).
- [ ] `@oplati/types` экспортирует `paymentProvider`, `paymentStatus`, `attachmentKind`, `actorType` zod-схемы.
- [ ] `packages/db/drizzle/0002_*.sql` и `0003_enable_rls_extended.sql` (если не no-op) закоммичены.
- [ ] В Supabase `nyxijwpuvctmvemaemqn`: 5 новых таблиц + 5 новых enum'ов; RLS на orders/order_events/payments/attachments; `services` без RLS.
- [ ] `CHECK (service_id IS NOT NULL OR custom_service_description IS NOT NULL)` форсится — negative insert падает.
- [ ] `UNIQUE(provider, provider_ref)` форсится — повторный insert падает с `23505`.
- [ ] `services` содержит 10 строк (Claude/ChatGPT/Netflix/Spotify/Airbnb/YouTube/Discord/Midjourney/LinkedIn/Apple) с правильным `requires_kyc` (true для Airbnb, LinkedIn Premium, Apple One).
- [ ] Повторный `pnpm db:seed` идемпотентен (UPSERT, никаких дубликатов).
- [ ] `pnpm typecheck && pnpm lint && pnpm build` зелёные.
- [ ] `.ai-factory/ROADMAP.md`: `[x] Расширение схемы БД` + строка в Completed.

## Что НЕ входит в этот план

- Repository-функции (`createOrder`, `transitionOrder`, `listActiveServices`, `recordPayment`, `appendOrderEvent`) — milestone «State machine заказа + AI tools».
- `transitionOrder()` с проверкой `allowedTransitions` + атомарной записью в `order_events` — следующий milestone.
- short_id генератор (`ORD-XXXXX` через nanoid) — следующий milestone, в repository-слое.
- RLS-политики для operator/supervisor/admin (operator_own_orders, supervisor_all_orders, order_events_readonly_*) — milestone «Минимальная админка» (нужны связки с Supabase Auth).
- DB-уровень enforcement append-only `order_events` (DENY UPDATE/DELETE policy + REVOKE BYPASSRLS) — milestone «State machine + AI tools».
- Триггеры на `updated_at` — пока обновляем в коде вручную (docs/database.md допускает оба варианта).
- AI tools (`search_catalog`, `propose_order`, `confirm_order`, `request_human`) — следующий milestone.
- Верификация placeholder-цен с владельцем — pre-production, отдельная задача.
