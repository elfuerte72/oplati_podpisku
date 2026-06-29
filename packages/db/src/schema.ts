import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  check,
  date,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { OrderParameters, PricingPolicy } from '@oplati/types';

// ─── Enums ────────────────────────────────────────────────────────────────

export const userChannelEnum = pgEnum('user_channel', ['telegram', 'web']);

export const staffRoleEnum = pgEnum('staff_role', [
  'operator',
  'supervisor',
  'admin',
]);

export const handoffModeEnum = pgEnum('handoff_mode', ['ai', 'operator']);

export const messageRoleEnum = pgEnum('message_role', [
  'user',
  'assistant',
  'operator',
  'system',
]);

// Литералы должны побайтово совпадать с zod-енумами в @oplati/types.
export const orderStatusEnum = pgEnum('order_status', [
  'draft',
  'clarifying',
  'kyc_required',
  'ready_for_payment',
  'pending_payment',
  'paid',
  'in_fulfillment',
  'completed',
  'failed',
  'cancelled',
  'expired',
  'refund_requested',
  'refunded',
]);

export const paymentProviderEnum = pgEnum('payment_provider', [
  'yookassa',
  'cryptobot',
  'sbp',
  'manual',
  'loveandpay',
  'paypace',
]);

export const cardStatusEnum = pgEnum('card_status', ['active', 'idle', 'recycled']);

export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'succeeded',
  'failed',
  'refunded',
]);

export const attachmentKindEnum = pgEnum('attachment_kind', [
  'payment_proof',
  'kyc',
  'fulfillment_proof',
  'other',
]);

export const actorTypeEnum = pgEnum('actor_type', [
  'system',
  'user',
  'operator',
  'supervisor',
  'ai',
  'payment_provider',
]);

// ─── Users (клиенты) ──────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    telegramId: text('telegram_id'),
    webSessionId: text('web_session_id'),
    displayName: text('display_name'),
    language: text('language').default('ru').notNull(),
    phone: text('phone'),
    email: text('email'),
    notes: text('notes'),
    // Реферальная программа. `referredBy` — пригласивший партнёр (self-FK).
    // Ставится ТОЛЬКО при создании строки (immutable: ON CONFLICT не трогает),
    // чтобы дерево сети нельзя было переписать задним числом. `referralCode` —
    // персональный код для deep-link `?start=ref_<code>`; lazy, UNIQUE (NULL
    // допускает множество строк). onDelete: set null — удаление реферера не
    // должно ронять строки рефералов (FK restrict здесь не нужен).
    referredBy: uuid('referred_by').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    referralCode: text('referral_code').unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    telegramIdx: uniqueIndex('users_telegram_id_idx')
      .on(t.telegramId)
      .where(sql`${t.telegramId} IS NOT NULL`),
    webSessionIdx: uniqueIndex('users_web_session_id_idx')
      .on(t.webSessionId)
      .where(sql`${t.webSessionId} IS NOT NULL`),
    referredByIdx: index('users_referred_by_idx').on(t.referredBy),
    identityCheck: check(
      'users_identity_present',
      sql`${t.telegramId} IS NOT NULL OR ${t.webSessionId} IS NOT NULL`,
    ),
  }),
).enableRLS();

// ─── Link tokens (привязка Telegram к веб-сессии) ─────────────────────────
// Одноразовый короткоживущий токен: создаётся по web_session_id на сайте,
// потребляется ботом из deep-link `/start link_<token>`. Полный flow —
// apps/web/app/api/auth/telegram/link + apps/web/lib/telegram/handle-update.ts.

export const linkTokens = pgTable(
  'link_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    token: text('token').notNull().unique(),
    webSessionId: text('web_session_id').notNull(),
    // кто потребил токен — заполняется при использовании (аудит)
    telegramId: text('telegram_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    webSessionIdx: index('link_tokens_web_session_id_idx').on(t.webSessionId),
  }),
).enableRLS();

// ─── Staff (операторы, супервизоры, админы) ───────────────────────────────

export const staff = pgTable('staff', {
  id: uuid('id').defaultRandom().primaryKey(),
  // Supabase Auth user.id — связка с auth.users
  authUserId: uuid('auth_user_id').unique(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: staffRoleEnum('role').notNull().default('operator'),
  telegramId: text('telegram_id'), // для нотификаций в личку
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}).enableRLS();

// ─── Conversations ────────────────────────────────────────────────────────

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    channel: userChannelEnum('channel').notNull(),
    handoffMode: handoffModeEnum('handoff_mode').default('ai').notNull(),
    assignedOperatorId: uuid('assigned_operator_id').references(() => staff.id),
    telegramTopicId: integer('telegram_topic_id'), // id форум-топика в группе операторов
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('conversations_user_id_idx').on(t.userId),
    operatorIdx: index('conversations_operator_id_idx').on(t.assignedOperatorId),
  }),
).enableRLS();

// ─── Messages ─────────────────────────────────────────────────────────────

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    // actor: для role='operator' — ссылка на staff; иначе NULL
    staffId: uuid('staff_id').references(() => staff.id),
    content: text('content').notNull(),
    // для AI: tool_calls, finish_reason, usage
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    conversationIdx: index('messages_conversation_id_idx').on(t.conversationId, t.createdAt),
  }),
).enableRLS();

// ─── Services (публичный каталог) ─────────────────────────────────────────

export const services = pgTable('services', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  // 'ai' | 'streaming' | 'travel' | 'productivity' | 'other'
  category: text('category'),
  requiresKyc: boolean('requires_kyc').default(false).notNull(),
  pricingPolicy: jsonb('pricing_policy').$type<PricingPolicy>(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}).enableRLS();

// ─── Orders ───────────────────────────────────────────────────────────────

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // 'ORD-7KX42'; генерация в repository-слое (следующий milestone)
    shortId: text('short_id').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
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
    parameters: jsonb('parameters').$type<OrderParameters>(),
    // MVP: курс USDT→RUB (как RUB-копейки за 1 USDT × 10000, например 9523456 = 95.23456 RUB/USDT)
    usdtRubRateKopecks: integer('usdt_rub_rate_kopecks'),
    rateFixedAt: timestamp('rate_fixed_at', { withTimezone: true }),
    // TTL счёта L&P (по умолчанию 24h)
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // Снапшот процента комиссии на момент создания заказа (10 = 10%)
    commissionPercent: integer('commission_percent'),
    // FK на cards.id — выставляется issue-card job-ом после успешной оплаты.
    // Lazy reference: cards объявлена ниже в этом же файле, стрелочная функция спасает от hoisting.
    cardId: uuid('card_id').references(() => cards.id, { onDelete: 'set null' }),
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
    // Частичный индекс под горячий cron-запрос findStuckPaidOrders (каждые 5 мин:
    // status='paid' AND paid_at < cutoff). Крошечный — только активные `paid`.
    stuckPaidIdx: index('orders_stuck_paid_idx')
      .on(t.paidAt)
      .where(sql`${t.status} = 'paid'`),
    serviceOrCustom: check(
      'orders_service_or_custom',
      sql`${t.serviceId} IS NOT NULL OR ${t.customServiceDescription} IS NOT NULL`,
    ),
  }),
).enableRLS();

// ─── Order events (append-only audit log) ─────────────────────────────────

export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    actorType: actorTypeEnum('actor_type').notNull(),
    // полиморфный actor: users.id или staff.id — FK не ставим (см. docs/database.md)
    actorId: uuid('actor_id'),
    // 'status_changed' | 'payment_succeeded' | ...
    eventType: text('event_type').notNull(),
    fromStatus: orderStatusEnum('from_status'),
    toStatus: orderStatusEnum('to_status'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orderTimeIdx: index('order_events_order_id_created_at_idx').on(t.orderId, t.createdAt),
  }),
).enableRLS();

// ─── Payments ─────────────────────────────────────────────────────────────

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    provider: paymentProviderEnum('provider').notNull(),
    providerRef: text('provider_ref').notNull(),
    // L&P invoice number (например INV-1234) — отображаемое значение, не идентификатор
    providerInvoiceNumber: text('provider_invoice_number'),
    amountRub: integer('amount_rub').notNull(), // копейки
    status: paymentStatusEnum('status').default('pending').notNull(),
    rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>(),
    // Платёж был восстановлен через cron-поллинг, а не webhook — Sentry warning при true
    recoveredViaPolling: boolean('recovered_via_polling').default(false).notNull(),
    // TTL счёта L&P
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    webhookReceivedAt: timestamp('webhook_received_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    // Инвариант идемпотентности webhook'ов (CLAUDE.md).
    providerRefIdx: uniqueIndex('payments_provider_provider_ref_idx').on(
      t.provider,
      t.providerRef,
    ),
    orderIdx: index('payments_order_id_idx').on(t.orderId),
  }),
).enableRLS();

// ─── Cards (app.pay.space виртуальные USD-карты) ──────────────────────────

export const cards = pgTable(
  'cards',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // 'paypace' (по умолчанию); строка а не enum — чтобы не плодить отдельный card_provider enum,
    // карты у нас всегда выпускает paypace, но текстовое поле упрощает расширение.
    provider: text('provider').notNull().default('paypace'),
    providerCardId: text('provider_card_id').notNull().unique(),
    panMasked: text('pan_masked').notNull(),
    status: cardStatusEnum('status').default('active').notNull(),
    balanceUsdCents: integer('balance_usd_cents').default(0).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    recycledAt: timestamp('recycled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('cards_user_id_idx').on(t.userId),
    // Частичный индекс — ускоряет findRecyclableCard / recycle cron.
    idleIdx: index('cards_idle_idx').on(t.status).where(sql`${t.status} = 'idle'`),
  }),
).enableRLS();

// ─── AI usage (дневной счётчик токенов для глобального бюджета) ───────────
// Одна строка = один UTC-день. Атомарный инкремент через
// INSERT ... ON CONFLICT (day) DO UPDATE (repositories/ai-usage.ts).
// Проверка порога и веса стоимости — apps/web/lib/ai/budget.ts.

export const aiUsageDaily = pgTable('ai_usage_daily', {
  // 'YYYY-MM-DD' по UTC — сутки бюджета сбрасываются в полночь UTC (03:00 МСК)
  day: date('day').primaryKey(),
  requests: integer('requests').default(0).notNull(),
  inputTokens: integer('input_tokens').default(0).notNull(),
  outputTokens: integer('output_tokens').default(0).notNull(),
  cacheReadTokens: integer('cache_read_tokens').default(0).notNull(),
  cacheWriteTokens: integer('cache_write_tokens').default(0).notNull(),
  webSearchRequests: integer('web_search_requests').default(0).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}).enableRLS();

// ─── Attachments (Supabase Storage refs) ──────────────────────────────────

export const attachments = pgTable('attachments', {
  id: uuid('id').defaultRandom().primaryKey(),
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  kind: attachmentKindEnum('kind').notNull(),
  storagePath: text('storage_path').notNull(),
  mimeType: text('mime_type'),
  sizeBytes: integer('size_bytes'),
  // полиморфный uploader: users.id или staff.id
  uploadedBy: uuid('uploaded_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}).enableRLS();
