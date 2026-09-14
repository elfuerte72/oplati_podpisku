import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import * as schema from './schema.ts';
import type { DB } from './index.ts';
import { createTestDb } from './test-harness.ts';
import { createDraftOrder } from './repositories/orders.ts';
import type { AnalyticsRange } from './repositories/analytics-panel.ts';
import {
  DAILY_PAID_ORDERS_MAX,
  dailyAudience,
  dailyOrderFlow,
  dailyPaidOrders,
  dailySupport,
} from './repositories/daily-report.ts';

/**
 * Выборки дневного отчёта — РЕАЛЬНЫЙ Postgres (PGlite) с РЕАЛЬНЫМИ миграциями:
 * «люди» читаются из вьюхи `analytics_timeline` (0029), переходы — из журнала
 * `order_events`, и подменой их не проверить.
 *
 * Окно — одни сутки по Москве: [01.03 00:00 МСК, 02.03 00:00 МСК) =
 * [28.02 21:00 UTC, 01.03 21:00 UTC). Фикстуры ставятся на секунду до и после
 * границ, чтобы полуоткрытость окна была явной.
 */

let db: DB;

const RANGE: AnalyticsRange = {
  since: '2026-02-28T21:00:00.000Z',
  until: '2026-03-01T21:00:00.000Z',
};
const EMPTY_RANGE: AnalyticsRange = {
  since: '2020-01-01T00:00:00.000Z',
  until: '2020-01-02T00:00:00.000Z',
};

const INSIDE = new Date('2026-03-01T09:00:00.000Z');
const JUST_BEFORE = new Date('2026-02-28T20:59:59.000Z');
const LAST_SECOND = new Date('2026-03-01T20:59:59.000Z');
const AT_UNTIL = new Date('2026-03-01T21:00:00.000Z');

let seq = 0;

async function makeUser(over: Partial<typeof schema.users.$inferInsert> = {}) {
  const rows = await db
    .insert(schema.users)
    .values({ telegramId: `tg-dr-${++seq}`, ...over })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('users insert');
  return row;
}

async function makeService(slug: string, name: string) {
  const rows = await db.insert(schema.services).values({ slug, name, category: 'test' }).returning();
  const row = rows[0];
  if (!row) throw new Error('services insert');
  return row;
}

async function makeOrder(input: { userId: string; serviceId?: string | null; amountKopecks?: number }) {
  return createDraftOrder(db, {
    userId: input.userId,
    status: 'draft',
    serviceId: input.serviceId ?? null,
    customServiceDescription: input.serviceId ? null : 'своя подписка',
    amountRub: input.amountKopecks ?? 100_000,
    originalAmount: 1000,
    originalCurrency: 'USD',
  });
}

/** Событие журнала с заданным временем: `createDraftOrder` пишет `now()`, а тесту нужны границы окна. */
async function logEvent(input: {
  orderId: string;
  eventType: string;
  toStatus?: (typeof schema.orderStatusEnum.enumValues)[number] | null;
  at: Date;
}) {
  await db.insert(schema.orderEvents).values({
    orderId: input.orderId,
    actorType: 'system',
    eventType: input.eventType,
    fromStatus: null,
    toStatus: input.toStatus ?? null,
    createdAt: input.at,
  });
}

async function markPaid(orderId: string, status: string, paidAt: Date) {
  await db.execute(
    sql`UPDATE orders SET status = ${status}::order_status, paid_at = ${paidAt.toISOString()}::timestamptz WHERE id = ${orderId}`,
  );
}

async function track(input: {
  name: string;
  channel: string;
  occurredAt: Date;
  telegramId?: string;
  webSessionId?: string;
}) {
  await db.insert(schema.analyticsEvents).values({
    eventKey: `dr-ev-${++seq}`,
    name: input.name,
    channel: input.channel,
    origin: 'server',
    telegramId: input.telegramId ?? null,
    webSessionId: input.webSessionId ?? null,
    occurredAt: input.occurredAt,
  });
}

beforeAll(async () => {
  ({ db } = await createTestDb());
});

describe('dailyAudience', () => {
  it('считает людей, а не события, и разделяет Telegram и сайт', async () => {
    const a = await makeUser();
    const b = await makeUser();
    // Один человек: /start и два открытия кабинета — один заход.
    await track({ name: 'bot_start', channel: 'bot', occurredAt: INSIDE, telegramId: a.telegramId! });
    await track({ name: 'cabinet_open', channel: 'miniapp', occurredAt: INSIDE, telegramId: a.telegramId! });
    await track({ name: 'cabinet_open', channel: 'miniapp', occurredAt: LAST_SECOND, telegramId: a.telegramId! });
    // Второй только открыл кабинет — без /start.
    await track({ name: 'cabinet_open', channel: 'miniapp', occurredAt: INSIDE, telegramId: b.telegramId! });
    // Анонимный посетитель сайта.
    await track({ name: 'page_view', channel: 'web', occurredAt: INSIDE, webSessionId: 'dr-web-1' });
    // За окном — не считаются.
    await track({ name: 'bot_start', channel: 'bot', occurredAt: JUST_BEFORE, telegramId: 'tg-outside-1' });
    await track({ name: 'bot_start', channel: 'bot', occurredAt: AT_UNTIL, telegramId: 'tg-outside-2' });

    const audience = await dailyAudience(db, RANGE);

    expect(audience.telegramVisitors).toBe(2);
    expect(audience.botStarts).toBe(1);
    expect(audience.cabinetOpens).toBe(2);
    expect(audience.webVisitors).toBe(1);
  });

  it('новые клиенты Telegram и закрепления по реф-ссылке — по времени события', async () => {
    const partner = await makeUser({ createdAt: JUST_BEFORE });
    await makeUser({ createdAt: INSIDE, referredBy: partner.id, referredBySetAt: INSIDE });
    await makeUser({ createdAt: AT_UNTIL });
    // Веб-строка без Telegram — не «новый клиент Telegram».
    await db.insert(schema.users).values({ webSessionId: 'dr-web-only', createdAt: INSIDE });

    const audience = await dailyAudience(db, RANGE);

    expect(audience.newTelegramUsers).toBe(1);
    expect(audience.referralJoins).toBe(1);
  });

  it('пустое окно — нули, а не ошибка', async () => {
    expect(await dailyAudience(db, EMPTY_RANGE)).toEqual({
      telegramVisitors: 0,
      botStarts: 0,
      cabinetOpens: 0,
      webVisitors: 0,
      newTelegramUsers: 0,
      referralJoins: 0,
    });
  });
});

describe('dailyOrderFlow', () => {
  it('считает заказы по журналу переходов за окно, повторный счёт — один заказ', async () => {
    const user = await makeUser();
    const paidTwice = await makeOrder({ userId: user.id });
    await logEvent({ orderId: paidTwice.id, eventType: 'order_created', toStatus: 'draft', at: INSIDE });
    await logEvent({ orderId: paidTwice.id, eventType: 'payment_invoice_created', at: INSIDE });
    await logEvent({ orderId: paidTwice.id, eventType: 'payment_invoice_created', at: LAST_SECOND });

    // Создан ВЧЕРА, истёк сегодня — в сегодняшние «истекли», не в «оформлено».
    const expired = await makeOrder({ userId: user.id });
    await logEvent({ orderId: expired.id, eventType: 'order_created', toStatus: 'draft', at: JUST_BEFORE });
    await logEvent({ orderId: expired.id, eventType: 'order_expired', toStatus: 'expired', at: INSIDE });

    const failed = await makeOrder({ userId: user.id });
    await logEvent({ orderId: failed.id, eventType: 'status_changed', toStatus: 'failed', at: INSIDE });

    const cancelled = await makeOrder({ userId: user.id });
    await logEvent({ orderId: cancelled.id, eventType: 'user_cancelled', toStatus: 'cancelled', at: INSIDE });

    const review = await makeOrder({ userId: user.id });
    await logEvent({ orderId: review.id, eventType: 'payment_review_entered', toStatus: 'payment_review', at: INSIDE });
    // Переход на правой границе окна — уже завтрашний.
    await logEvent({ orderId: review.id, eventType: 'status_changed', toStatus: 'failed', at: AT_UNTIL });

    const flow = await dailyOrderFlow(db, RANGE);

    expect(flow).toEqual({
      created: 1,
      invoiced: 1,
      expired: 1,
      cancelled: 1,
      failed: 1,
      paymentReview: 1,
    });
  });
});

describe('dailyPaidOrders', () => {
  it('отдаёт оплаченные за окно в любом статусе, по времени оплаты, с клиентом и сервисом', async () => {
    const service = await makeService('dr-chatgpt', 'ChatGPT');
    const alice = await makeUser({ telegramUsername: 'alice_dr', displayName: 'Алиса' });
    const bob = await makeUser({ displayName: 'Боб' });

    const late = await makeOrder({ userId: alice.id, serviceId: service.id, amountKopecks: 228_000 });
    await db.execute(
      sql`UPDATE orders SET parameters = '{"tierName":"Plus"}'::jsonb WHERE id = ${late.id}`,
    );
    await markPaid(late.id, 'completed', LAST_SECOND);

    // Деньги пришли, карта не выпустилась — обязан быть в списке.
    const failedAfterPay = await makeOrder({ userId: bob.id, amountKopecks: 50_000 });
    await markPaid(failedAfterPay.id, 'failed', INSIDE);

    const outside = await makeOrder({ userId: bob.id });
    await markPaid(outside.id, 'completed', AT_UNTIL);

    const { items, total } = await dailyPaidOrders(db, RANGE);

    expect(total).toBe(2);
    expect(items.map((i) => i.shortId)).toEqual([failedAfterPay.shortId, late.shortId]);
    expect(items[0]).toMatchObject({
      status: 'failed',
      amountKopecks: 50_000,
      serviceName: null,
      customDescription: 'своя подписка',
      telegramUsername: null,
      displayName: 'Боб',
    });
    expect(items[1]).toMatchObject({
      status: 'completed',
      amountKopecks: 228_000,
      serviceName: 'ChatGPT',
      tierName: 'Plus',
      telegramUsername: 'alice_dr',
    });
    expect(items[1]?.paidAt.toISOString()).toBe(LAST_SECOND.toISOString());
  });

  it('потолок списка не прячет общее число', async () => {
    const { items, total } = await dailyPaidOrders(db, RANGE, 1);
    expect(items).toHaveLength(1);
    expect(total).toBe(2);
    // Запрошенный сверх потолка лимит клампится.
    const wide = await dailyPaidOrders(db, RANGE, 10_000);
    expect(wide.items.length).toBeLessThanOrEqual(DAILY_PAID_ORDERS_MAX);
  });
});

describe('dailySupport', () => {
  it('обращения — люди, оценки — среднее до десятых и число низких', async () => {
    const user = await makeUser();
    const other = await makeUser();
    await track({ name: 'support_requested', channel: 'bot', occurredAt: INSIDE, telegramId: user.telegramId! });
    await track({ name: 'support_requested', channel: 'bot', occurredAt: INSIDE, telegramId: user.telegramId! });

    const o1 = await makeOrder({ userId: user.id });
    const o2 = await makeOrder({ userId: other.id });
    const o3 = await makeOrder({ userId: other.id });
    await db.insert(schema.clientFeedback).values([
      { userId: user.id, orderId: o1.id, kind: 'order_rating', score: 5, createdAt: INSIDE },
      { userId: other.id, orderId: o2.id, kind: 'order_rating', score: 2, createdAt: LAST_SECOND },
      { userId: other.id, orderId: o3.id, kind: 'order_rating', score: 1, createdAt: AT_UNTIL },
    ]);

    expect(await dailySupport(db, RANGE)).toEqual({
      requests: 1,
      ratings: 2,
      ratingAverage: 3.5,
      lowRatings: 1,
    });
  });

  it('без оценок средняя — null, а не ноль', async () => {
    expect(await dailySupport(db, EMPTY_RANGE)).toEqual({
      requests: 0,
      ratings: 0,
      ratingAverage: null,
      lowRatings: 0,
    });
  });
});
