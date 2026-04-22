import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ─── Enums ────────────────────────────────────────────────────────────────

export const userChannelEnum = pgEnum('user_channel', ['telegram', 'web']);

export const staffRoleEnum = pgEnum('staff_role', [
  'operator',
  'supervisor',
  'admin',
]);

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

export const messageRoleEnum = pgEnum('message_role', [
  'user',
  'assistant',
  'operator',
  'system',
]);

export const handoffModeEnum = pgEnum('handoff_mode', ['ai', 'operator']);

export const paymentProviderEnum = pgEnum('payment_provider', [
  'yookassa',
  'cryptobot',
  'sbp',
  'manual',
]);

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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    telegramIdx: uniqueIndex('users_telegram_id_idx').on(t.telegramId),
    webSessionIdx: uniqueIndex('users_web_session_id_idx').on(t.webSessionId),
  }),
);

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
});

// ─── Services (каталог) ───────────────────────────────────────────────────

export const services = pgTable('services', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  category: text('category'), // ai, streaming, travel, productivity
  requiresKyc: boolean('requires_kyc').default(false).notNull(),
  // гибкая структура тарифов/регионов
  pricingPolicy: jsonb('pricing_policy').$type<{
    tiers: Array<{ name: string; period: 'month' | 'year'; priceRub: number; originalAmount?: number; currency?: string }>;
    margin?: number;
  }>(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

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
);

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
);

// ─── Orders ───────────────────────────────────────────────────────────────

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // короткий человекочитаемый id для топиков и ссылок
    shortId: text('short_id').notNull().unique(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    // либо сервис из каталога, либо свободный запрос
    serviceId: uuid('service_id').references(() => services.id),
    customServiceDescription: text('custom_service_description'),

    status: orderStatusEnum('status').default('draft').notNull(),

    // суммы в копейках (integer) — никогда не numeric
    amountRub: integer('amount_rub'),
    originalAmount: integer('original_amount'), // в минимальных единицах оригинальной валюты
    originalCurrency: text('original_currency'),

    requiresKyc: boolean('requires_kyc').default(false).notNull(),
    kycCompletedAt: timestamp('kyc_completed_at', { withTimezone: true }),

    assignedOperatorId: uuid('assigned_operator_id').references(() => staff.id),
    supervisorId: uuid('supervisor_id').references(() => staff.id),

    // параметры заказа (email клиента в сервисе, регион, тариф и т.п.)
    parameters: jsonb('parameters').$type<Record<string, unknown>>(),

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
  }),
);

// ─── Order events (audit log, append-only) ────────────────────────────────

export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: uuid('actor_id'), // staff.id или users.id, зависит от actorType
    eventType: text('event_type').notNull(), // status_changed, payment_succeeded, assigned_operator...
    fromStatus: orderStatusEnum('from_status'),
    toStatus: orderStatusEnum('to_status'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orderIdx: index('order_events_order_id_idx').on(t.orderId, t.createdAt),
  }),
);

// ─── Payments ─────────────────────────────────────────────────────────────

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
    provider: paymentProviderEnum('provider').notNull(),
    providerRef: text('provider_ref').notNull(), // id платежа у провайдера
    amountRub: integer('amount_rub').notNull(),
    status: paymentStatusEnum('status').default('pending').notNull(),
    rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    // идемпотентность: один и тот же webhook не создаёт дубль
    providerRefIdx: uniqueIndex('payments_provider_ref_idx').on(t.provider, t.providerRef),
    orderIdx: index('payments_order_id_idx').on(t.orderId),
  }),
);

// ─── Attachments (Supabase Storage) ───────────────────────────────────────

export const attachments = pgTable('attachments', {
  id: uuid('id').defaultRandom().primaryKey(),
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  kind: attachmentKindEnum('kind').notNull(),
  storagePath: text('storage_path').notNull(), // путь в Supabase Storage bucket
  mimeType: text('mime_type'),
  sizeBytes: integer('size_bytes'),
  uploadedBy: uuid('uploaded_by'), // users.id или staff.id
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
