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
  primaryKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type {
  OrderParameters,
  PricingPolicy,
  ServicePaymentInstructions,
} from '@oplati/types';

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
    // Когда установлен referred_by — для гейта recovery-начислений против ретро-
    // атрибуции (D-REF-9): merge может проставить реферера ПОСЛЕ оплаты заказов,
    // и без этой отметки recovery-cron back-pay'нул бы комиссию на исторические
    // заказы. Гейт: начисляем только если order.paid_at >= referred_by_set_at.
    referredBySetAt: timestamp('referred_by_set_at', { withTimezone: true }),
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
    // Defense-in-depth для денежного дерева: запрет self-edge на уровне БД
    // (immutability-after-set остаётся app-enforced).
    noSelfReferral: check(
      'users_no_self_referral',
      sql`${t.referredBy} IS NULL OR ${t.referredBy} <> ${t.id}`,
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
    // Покрытие FK (аудит 2026-07-11 F-10): без индекса удаление/поиск по staff
    // деградирует в seq scan по messages.
    staffIdx: index('messages_staff_id_idx').on(t.staffId),
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
  // Пер-сервисные правила оплаты на сайте сервиса (VPN/валюта/billing/ссылка) —
  // схема servicePaymentInstructions в @oplati/types. NULL — generic-подсказка.
  paymentInstructions: jsonb('payment_instructions').$type<ServicePaymentInstructions>(),
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
    // Курс USDT→RUB × 10000; например 80.1200 RUB/USDT хранится как 801200.
    usdtRubRateKopecks: integer('usdt_rub_rate_kopecks'),
    rateFixedAt: timestamp('rate_fixed_at', { withTimezone: true }),
    // TTL счёта L&P (по умолчанию 24h)
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // Снапшот процента комиссии на момент создания заказа (10 = 10%)
    commissionPercent: integer('commission_percent'),
    // Снапшот разовой надбавки за выпуск карты (RUB-копейки), уже включённой в
    // amount_rub. NULL — заказ создан до появления фичи; 0 — надбавки не было
    // (повторная оплата: карта уже выпущена, топап без issue-fee); >0 — первая
    // оплата, клиент оплатил $4 issue-fee (по курсу заказа).
    cardIssueFeeKopecks: integer('card_issue_fee_kopecks'),
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
    // Покрытие FK (аудит 2026-07-11 F-10): cascade/restrict-проверки и join'ы
    // по этим ссылкам без индексов деградируют в seq scan при росте orders.
    conversationIdx: index('orders_conversation_id_idx').on(t.conversationId),
    serviceIdx: index('orders_service_id_idx').on(t.serviceId),
    supervisorIdx: index('orders_supervisor_id_idx').on(t.supervisorId),
    cardIdx: index('orders_card_id_idx').on(t.cardId),
    // Частичный индекс под горячий cron-запрос findStuckPaidOrders (каждые 5 мин:
    // status='paid' AND paid_at < cutoff). Крошечный — только активные `paid`.
    stuckPaidIdx: index('orders_stuck_paid_idx')
      .on(t.paidAt)
      .where(sql`${t.status} = 'paid'`),
    // M-12 аудита: cron-выборки по вечно растущей таблице.
    // renewal-reminder: status='completed' AND fulfilled_at BETWEEN … — частичный
    // индекс только по завершённым.
    completedFulfilledIdx: index('orders_completed_fulfilled_at_idx')
      .on(t.fulfilledAt)
      .where(sql`${t.status} = 'completed'`),
    // referral-recovery (каждый час): o.paid_at >= now() - 30 days — предикат
    // по orders.paid_at (НЕ payments), частичный по непустым.
    paidAtIdx: index('orders_paid_at_idx')
      .on(t.paidAt)
      .where(sql`${t.paidAt} IS NOT NULL`),
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
    // Максимум один живой (pending) платёж на заказ — DB-энфорс против TOCTOU
    // двух конкурентных confirm_order (двойной инвойс L&P на один заказ,
    // находка аудита I3). Проигравший INSERT получает 23505 и возвращает
    // клиенту уже существующий инвойс (payments/create).
    onePendingPerOrderIdx: uniqueIndex('payments_one_pending_per_order_idx')
      .on(t.orderId)
      .where(sql`${t.status} = 'pending'`),
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

// ─── VPN subscriptions (Remnawave) ────────────────────────────────────────
// Одна строка = одна выданная ссылка-подписка VPN на пользователя (кнопка
// «VPN» в боте). Источник истины по доступу — панель Remnawave; здесь снимок
// для идемпотентной выдачи той же ссылки без похода в панель.
// `remnawave_uuid` — id юзера панели для revoke/PATCH/DELETE (это
// `response.uuid`, НЕ `vlessUuid`). «Обновить ссылку» = revoke в панели →
// UPDATE строки на месте (short_uuid/subscription_url меняются, expire_at
// осознанно НЕ продлевается — иначе кнопка была бы бесплатным продлением).

export const vpnSubscriptions = pgTable(
  'vpn_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Дубль telegram_id (text — как users.telegram_id): ключ поиска юзера в
    // панели (`by-telegram-id`), устойчив к merge веб/telegram-строк users.
    telegramId: text('telegram_id').notNull(),
    remnawaveUuid: uuid('remnawave_uuid').notNull(),
    shortUuid: text('short_uuid').notNull(),
    subscriptionUrl: text('subscription_url').notNull(),
    // Зеркало статуса панели (ACTIVE/DISABLED/LIMITED/EXPIRED) на момент
    // последней операции; панель сама переводит в EXPIRED по expire_at.
    status: text('status').notNull().default('ACTIVE'),
    expireAt: timestamp('expire_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Один VPN на пользователя (и на telegram-аккаунт, и на юзера панели) —
    // повторное нажатие кнопки возвращает существующую ссылку, дубли не плодятся.
    userIdx: uniqueIndex('vpn_subscriptions_user_id_idx').on(t.userId),
    telegramIdx: uniqueIndex('vpn_subscriptions_telegram_id_idx').on(t.telegramId),
    remnawaveIdx: uniqueIndex('vpn_subscriptions_remnawave_uuid_idx').on(t.remnawaveUuid),
  }),
).enableRLS();

// ─── Referral (партнёрская программа) ─────────────────────────────────────
// Append-only ledger начислений + профиль партнёра + заявки на вывод. Деньги —
// USD-центы integer. RLS deny-by-default (service_role обходит); партнёр читает
// своё через server-side кабинет (как cards). См. SPEC.md §5, plan.md Этап B.

export const referralAccrualKindEnum = pgEnum('referral_accrual_kind', [
  'commission',
  'circle_bonus',
  'sprint_new_refs',
  'sprint_turnover_boost',
  'serial_bonus',
]);

export const referralAccrualStatusEnum = pgEnum('referral_accrual_status', [
  'accrued',
  'reversed',
]);

export const referralPayoutStatusEnum = pgEnum('referral_payout_status', [
  'requested',
  'processing',
  'paid',
  'rejected',
]);

// Способ выплаты (Этап E): карта РФ (RUB) или USDT-кошелёк (крипта).
export const referralPayoutMethodEnum = pgEnum('referral_payout_method', [
  'card_rub',
  'crypto_usdt',
]);

// Профиль партнёра (1:1 с users, ленивое создание). Круг/ставка/множитель пишет
// месячный крон (Этап C); при отсутствии строки начисление считает по кругу 0.
export const referralPartners = pgTable('referral_partners', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  // 0 = Клиент .. 3 = Топ-партнёр (храповик — не понижается, Этап C)
  currentCircle: integer('current_circle').default(0).notNull(),
  // зафиксированная ставка L1 в bps (400 = 4%)
  lockedRateL1Bps: integer('locked_rate_l1_bps').default(400).notNull(),
  // временный +1% буст на следующий месяц (Этап C): действует до даты включительно
  boostUntil: date('boost_until'),
  boostRateBps: integer('boost_rate_bps'),
  // 5+ активных рефералов L2 → ставка L2 2%→2.5% (Этап C)
  teamMultiplier: boolean('team_multiplier').default(false).notNull(),
  // антифрод-блок: исключает из начисления и замораживает вывод (Этап E)
  suspended: boolean('suspended').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}).enableRLS();

// Append-only ledger начислений. НИКОГДА не UPDATE/DELETE — reversal = новая
// строка со status='reversed'. Идемпотентность commission — UNIQUE(payment_id,
// beneficiary, level); NULL payment_id (бонусы) не конфликтуют (NULL distinct).
export const referralAccruals = pgTable(
  'referral_accruals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    beneficiaryUserId: uuid('beneficiary_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // кто оплатил (null для бонусов)
    sourceUserId: uuid('source_user_id').references(() => users.id, { onDelete: 'set null' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    // 1..3 уровень сети; 0 для бонусов (circle/sprint/serial)
    level: integer('level').notNull(),
    kind: referralAccrualKindEnum('kind').notNull(),
    rateBps: integer('rate_bps').notNull(),
    amountUsdCents: integer('amount_usd_cents').notNull(),
    status: referralAccrualStatusEnum('status').default('accrued').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    beneficiaryIdx: index('referral_accruals_beneficiary_idx').on(t.beneficiaryUserId),
    // Идемпотентность commission: один платёж → ровно одна строка на (beneficiary, level).
    // Частичный (только status='accrued', находка аудита I2): полный unique
    // блокировал бы reversal-контракт — «reversal = НОВАЯ строка status='reversed'»
    // с теми же (payment_id, beneficiary, level).
    paymentBeneficiaryLevelIdx: uniqueIndex('referral_accruals_payment_beneficiary_level_idx')
      .on(t.paymentId, t.beneficiaryUserId, t.level)
      .where(sql`${t.status} = 'accrued'`),
    // Recovery/orderHasAccruals пробят по order_id — индекс (находка код-ревью, перф).
    orderIdx: index('referral_accruals_order_id_idx').on(t.orderId),
    // Покрытие FK source_user_id (аудит 2026-07-11 F-10): ON DELETE SET NULL
    // при удалении user без индекса сканирует весь ledger.
    sourceUserIdx: index('referral_accruals_source_user_id_idx').on(t.sourceUserId),
    // Деньги неотрицательны (defense-in-depth): начисления всегда > 0 (план дропает
    // floor-в-ноль), reversal — положительная строка со status='reversed'.
    amountNonNeg: check('referral_accruals_amount_nonneg', sql`${t.amountUsdCents} >= 0`),
  }),
).enableRLS();

// Заявки на вывод. Исполнение — Этап E (способ выплат D-REF-6). destination —
// контракт зависит от способа (крипто-адрес/карта), пока jsonb.
export const referralPayouts = pgTable(
  'referral_payouts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    amountUsdCents: integer('amount_usd_cents').notNull(),
    status: referralPayoutStatusEnum('status').default('requested').notNull(),
    // Способ выплаты и удержанная комиссия вывода (Этап E). NULL до заполнения
    // реквизитов: заявку можно создать без destination (способ выплат D-REF-6),
    // тогда method/fee проставит будущая форма реквизитов. amount_usd_cents —
    // брутто (вычитается из баланса); net = amount − fee уходит партнёру.
    method: referralPayoutMethodEnum('method'),
    feeUsdCents: integer('fee_usd_cents'),
    destination: jsonb('destination').$type<Record<string, unknown>>(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('referral_payouts_user_idx').on(t.userId),
    amountPositive: check('referral_payouts_amount_positive', sql`${t.amountUsdCents} > 0`),
  }),
).enableRLS();

// Помесячные агрегаты прогрессии (Этап C) — пишет крон `referral-rollup` один раз
// на партнёра за месяц. PK(user_id, month) даёт естественную идемпотентность
// (повторный запуск месяца — ON CONFLICT DO NOTHING). `month` — первое число
// месяца (UTC). Оборот сети USD-центы integer (месячный объём << int32-предела для
// масштаба проекта; в духе «деньги — integer»). `consecutive_met_months` — длина
// серии выполненных планов, включая этот месяц (для серийного бонуса).
export const referralMonthlyStats = pgTable(
  'referral_monthly_stats',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    month: date('month').notNull(),
    networkTurnoverUsdCents: integer('network_turnover_usd_cents').default(0).notNull(),
    newActiveReferrals: integer('new_active_referrals').default(0).notNull(),
    activeL2: integer('active_l2').default(0).notNull(),
    planMet: boolean('plan_met').default(false).notNull(),
    consecutiveMetMonths: integer('consecutive_met_months').default(0).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.month] }),
    turnoverNonNeg: check(
      'referral_monthly_stats_turnover_nonneg',
      sql`${t.networkTurnoverUsdCents} >= 0`,
    ),
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

export const attachments = pgTable(
  'attachments',
  {
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
  },
  (t) => ({
    // Покрытие FK (аудит 2026-07-11 F-10): ON DELETE SET NULL по orders/messages
    // без индексов сканирует attachments целиком.
    orderIdx: index('attachments_order_id_idx').on(t.orderId),
    messageIdx: index('attachments_message_id_idx').on(t.messageId),
  }),
).enableRLS();
