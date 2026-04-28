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

export const handoffModeEnum = pgEnum('handoff_mode', ['ai', 'operator']);

export const messageRoleEnum = pgEnum('message_role', [
  'user',
  'assistant',
  'operator',
  'system',
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
    telegramIdx: uniqueIndex('users_telegram_id_idx')
      .on(t.telegramId)
      .where(sql`${t.telegramId} IS NOT NULL`),
    webSessionIdx: uniqueIndex('users_web_session_id_idx')
      .on(t.webSessionId)
      .where(sql`${t.webSessionId} IS NOT NULL`),
    identityCheck: check(
      'users_identity_present',
      sql`${t.telegramId} IS NOT NULL OR ${t.webSessionId} IS NOT NULL`,
    ),
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
