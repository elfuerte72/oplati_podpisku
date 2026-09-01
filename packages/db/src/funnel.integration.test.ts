import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import * as schema from './schema.ts';
import type { DB } from './index.ts';
import { createTestDb } from './test-harness.ts';
import { createDraftOrder } from './repositories/orders.ts';
import {
  claimFunnelSend,
  countFunnelSendsSince,
  findCompletedOrdersForRating,
  findExpiredOrdersForSurvey,
  findFreshUsersWithoutOrders,
  findRatedUsersForReferralNudge,
  getFunnelUserState,
  getLastFunnelSendAt,
  hasActiveOperatorConversation,
  recordClientFeedback,
  setFunnelOptOut,
} from './repositories/funnel.ts';

/**
 * Интеграционные тесты воронки обратной связи (спека `.scratch/retention-funnel/`,
 * тикет 01) — РЕАЛЬНЫЙ Postgres (PGlite) с РЕАЛЬНЫМИ миграциями: атомарность
 * claim'ов и частичные UNIQUE иначе не проверить (prior art — тесты
 * `claimRenewalReminder` и `claimPaymentReminder`).
 */

let db: DB;

beforeAll(async () => {
  ({ db } = await createTestDb());
});

let userSeq = 0;
async function createTgUser(overrides: { createdAt?: Date; funnelOptOutAt?: Date } = {}) {
  const rows = await db
    .insert(schema.users)
    .values({
      telegramId: `funnel-tg-${++userSeq}`,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      ...(overrides.funnelOptOutAt ? { funnelOptOutAt: overrides.funnelOptOutAt } : {}),
    })
    .returning({ id: schema.users.id });
  return rows[0]!;
}

async function createWebUser(overrides: { createdAt?: Date } = {}) {
  const rows = await db
    .insert(schema.users)
    .values({
      webSessionId: `funnel-web-${++userSeq}`,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    })
    .returning({ id: schema.users.id });
  return rows[0]!;
}

/**
 * Заказ в нужном статусе с событием входа на нужное время. Создаётся
 * ЧЕРНОВИКОМ: `createDraftOrder` пишет стартовое событие с переданным
 * статусом, и оно оказалось бы свежее нашего — `max()` брал бы его, а тест
 * проверял бы не то, что заявляет (prior art — тесты
 * `findStuckInFulfillmentOrders`). Статус старим прямым UPDATE (аранжировка),
 * событие вставляем с нужным `created_at` — append-only-триггер INSERT
 * разрешает. `enteredAt: null` — заказ без события перехода (данные до
 * появления журнала): выборки обязаны его игнорировать.
 */
async function createOrderInStatus(
  userId: string,
  status: 'expired' | 'completed',
  enteredAt: Date | null,
) {
  const order = await createDraftOrder(db, {
    userId,
    status: 'draft',
    customServiceDescription: 'funnel-test order',
  });
  await db.execute(sql`UPDATE orders SET status = ${status}::order_status WHERE id = ${order.id}`);
  if (enteredAt) {
    await db.insert(schema.orderEvents).values({
      orderId: order.id,
      actorType: 'system',
      eventType: 'status_changed',
      toStatus: status,
      createdAt: enteredAt,
    });
  }
  return order;
}

const HOUR = 60 * 60 * 1000;
const now = () => new Date();
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);

describe('claimFunnelSend — атомарный claim на частичных UNIQUE', () => {
  it('двойной claim одноразового kind (user, expired_survey) — одна строка', async () => {
    const user = await createTgUser();

    const first = await claimFunnelSend(db, { userId: user.id, kind: 'expired_survey' });
    const second = await claimFunnelSend(db, { userId: user.id, kind: 'expired_survey' });

    expect(first).toBe(true);
    expect(second).toBe(false);

    const rows = await db
      .select()
      .from(schema.funnelSends)
      .where(eq(schema.funnelSends.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it('order_rating: повторный claim того же заказа — false; другой заказ того же клиента — true', async () => {
    const user = await createTgUser();
    const orderA = await createOrderInStatus(user.id, 'completed', null);
    const orderB = await createOrderInStatus(user.id, 'completed', null);

    expect(
      await claimFunnelSend(db, { userId: user.id, kind: 'order_rating', orderId: orderA.id }),
    ).toBe(true);
    expect(
      await claimFunnelSend(db, { userId: user.id, kind: 'order_rating', orderId: orderA.id }),
    ).toBe(false);
    // Оценка не входит в одноразовый индекс — второй заказ клеймится (правило
    // «не чаще 90 дней» живёт в привратнике, не в БД).
    expect(
      await claimFunnelSend(db, { userId: user.id, kind: 'order_rating', orderId: orderB.id }),
    ).toBe(true);
  });

  it('разные одноразовые kind у одного клиента не конфликтуют', async () => {
    const user = await createTgUser();
    expect(await claimFunnelSend(db, { userId: user.id, kind: 'start_survey' })).toBe(true);
    expect(await claimFunnelSend(db, { userId: user.id, kind: 'referral_nudge' })).toBe(true);
  });
});

describe('бюджет: счётчики по скользящим окнам', () => {
  it('countFunnelSendsSince считает только отправки внутри окна', async () => {
    const user = await createTgUser();
    // Прямые INSERT со старыми sent_at — аранжировка состояния «как на проде».
    await db.insert(schema.funnelSends).values([
      { userId: user.id, kind: 'expired_survey', sentAt: hoursAgo(30) },
      { userId: user.id, kind: 'start_survey', sentAt: hoursAgo(2) },
    ]);

    expect(await countFunnelSendsSince(db, user.id, hoursAgo(24))).toBe(1);
    expect(await countFunnelSendsSince(db, user.id, hoursAgo(24 * 7))).toBe(2);
  });

  it('getLastFunnelSendAt отдаёт последнюю отправку вида, null — если не было', async () => {
    const user = await createTgUser();
    expect(await getLastFunnelSendAt(db, user.id, 'order_rating')).toBeNull();

    const orderA = await createOrderInStatus(user.id, 'completed', null);
    const orderB = await createOrderInStatus(user.id, 'completed', null);
    const oldAt = hoursAgo(100 * 24);
    const freshAt = hoursAgo(24);
    await db.insert(schema.funnelSends).values([
      { userId: user.id, kind: 'order_rating', orderId: orderA.id, sentAt: oldAt },
      { userId: user.id, kind: 'order_rating', orderId: orderB.id, sentAt: freshAt },
    ]);

    const last = await getLastFunnelSendAt(db, user.id, 'order_rating');
    expect(last?.getTime()).toBe(freshAt.getTime());
  });
});

describe('setFunnelOptOut — «Больше не напоминать»', () => {
  it('ставит отметку один раз; повторный клик не омолаживает её', async () => {
    const user = await createTgUser();

    await setFunnelOptOut(db, user.id);
    const first = await getFunnelUserState(db, user.id);
    expect(first?.funnelOptOutAt).toBeInstanceOf(Date);

    await setFunnelOptOut(db, user.id);
    const second = await getFunnelUserState(db, user.id);
    expect(second?.funnelOptOutAt?.getTime()).toBe(first?.funnelOptOutAt?.getTime());
  });
});

describe('recordClientFeedback — первый клик побеждает', () => {
  it('повторный ответ на опрос не дублирует и не перезаписывает строку', async () => {
    const user = await createTgUser();

    expect(
      await recordClientFeedback(db, { userId: user.id, kind: 'expired_survey', answer: 'price' }),
    ).toBe(true);
    expect(
      await recordClientFeedback(db, { userId: user.id, kind: 'expired_survey', answer: 'howto' }),
    ).toBe(false);

    const rows = await db
      .select()
      .from(schema.clientFeedback)
      .where(eq(schema.clientFeedback.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answer).toBe('price');
  });

  it('двойной клик по звезде — одна строка, счёт первого клика', async () => {
    const user = await createTgUser();
    const order = await createOrderInStatus(user.id, 'completed', null);

    expect(
      await recordClientFeedback(db, {
        userId: user.id,
        kind: 'order_rating',
        orderId: order.id,
        score: 5,
      }),
    ).toBe(true);
    expect(
      await recordClientFeedback(db, {
        userId: user.id,
        kind: 'order_rating',
        orderId: order.id,
        score: 1,
      }),
    ).toBe(false);

    const rows = await db
      .select()
      .from(schema.clientFeedback)
      .where(eq(schema.clientFeedback.orderId, order.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.score).toBe(5);
  });

  it('оценка вне 1..5 отбивается CHECK-ом на уровне БД', async () => {
    const user = await createTgUser();
    const order = await createOrderInStatus(user.id, 'completed', null);

    // Текст ошибки драйвер оборачивает («Failed query: …»), поэтому ассертим
    // сам отказ и отсутствие строки, а не имя constraint'а в message.
    await expect(
      recordClientFeedback(db, {
        userId: user.id,
        kind: 'order_rating',
        orderId: order.id,
        score: 7,
      }),
    ).rejects.toThrow();
    const rows = await db
      .select()
      .from(schema.clientFeedback)
      .where(eq(schema.clientFeedback.orderId, order.id));
    expect(rows).toHaveLength(0);
  });
});

describe('hasActiveOperatorConversation — лениво гаснущий режим', () => {
  async function createConversationInMode(
    userId: string,
    mode: 'idle' | 'ai' | 'operator',
    modeExpiresAt: Date | null,
  ) {
    await db.insert(schema.conversations).values({
      userId,
      channel: 'telegram',
      handoffMode: mode,
      modeExpiresAt,
    });
  }

  it('operator без срока («ждём человека») блокирует', async () => {
    const user = await createTgUser();
    await createConversationInMode(user.id, 'operator', null);
    expect(await hasActiveOperatorConversation(db, user.id, now())).toBe(true);
  });

  it('operator с живым сроком блокирует, с истёкшим — нет (лениво погас)', async () => {
    const alive = await createTgUser();
    await createConversationInMode(alive.id, 'operator', new Date(Date.now() + HOUR));
    expect(await hasActiveOperatorConversation(db, alive.id, now())).toBe(true);

    const expired = await createTgUser();
    await createConversationInMode(expired.id, 'operator', hoursAgo(1));
    expect(await hasActiveOperatorConversation(db, expired.id, now())).toBe(false);
  });

  it('idle и ai не блокируют', async () => {
    const user = await createTgUser();
    await createConversationInMode(user.id, 'idle', null);
    await createConversationInMode(user.id, 'ai', new Date(Date.now() + HOUR));
    expect(await hasActiveOperatorConversation(db, user.id, now())).toBe(false);
  });
});

describe('findExpiredOrdersForSurvey (msg1) — окно и но-бэкфилл', () => {
  const window = { from: hoursAgo(24), to: hoursAgo(3) };

  it('заказ с входом в expired внутри окна попадает; старше окна — никогда (но-бэкфилл)', async () => {
    const inWindow = await createTgUser();
    const order = await createOrderInStatus(inWindow.id, 'expired', hoursAgo(5));

    const old = await createTgUser();
    await createOrderInStatus(old.id, 'expired', hoursAgo(48));

    const noEvent = await createTgUser();
    await createOrderInStatus(noEvent.id, 'expired', null);

    const rows = await findExpiredOrdersForSurvey(db, window);
    const userIds = rows.map((r) => r.userId);
    expect(userIds).toContain(inWindow.id);
    expect(rows.find((r) => r.userId === inWindow.id)?.orderId).toBe(order.id);
    expect(userIds).not.toContain(old.id);
    // Заказ без события перехода (данные до появления журнала) — не рассылается.
    expect(userIds).not.toContain(noEvent.id);
  });

  it('заказ моложе окна (задержка 3 часа ещё не прошла) не попадает', async () => {
    const user = await createTgUser();
    await createOrderInStatus(user.id, 'expired', hoursAgo(1));

    const rows = await findExpiredOrdersForSurvey(db, window);
    expect(rows.map((r) => r.userId)).not.toContain(user.id);
  });

  it('клиент с уже отправленным опросом исключается из выборки', async () => {
    const user = await createTgUser();
    await createOrderInStatus(user.id, 'expired', hoursAgo(5));
    await claimFunnelSend(db, { userId: user.id, kind: 'expired_survey' });

    const rows = await findExpiredOrdersForSurvey(db, window);
    expect(rows.map((r) => r.userId)).not.toContain(user.id);
  });
});

describe('findFreshUsersWithoutOrders (msg2)', () => {
  const window = { from: hoursAgo(72), to: hoursAgo(24) };

  it('свежий telegram-пользователь без заказов попадает; с заказом — нет', async () => {
    const fresh = await createTgUser({ createdAt: hoursAgo(30) });

    const withOrder = await createTgUser({ createdAt: hoursAgo(30) });
    await createOrderInStatus(withOrder.id, 'expired', null);

    const rows = await findFreshUsersWithoutOrders(db, window);
    const ids = rows.map((r) => r.userId);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(withOrder.id);
  });

  it('веб-пользователь без Telegram, отписанный и вне окна — не попадают', async () => {
    const web = await createWebUser({ createdAt: hoursAgo(30) });
    const opted = await createTgUser({ createdAt: hoursAgo(30), funnelOptOutAt: hoursAgo(1) });
    const tooFresh = await createTgUser({ createdAt: hoursAgo(2) });
    const tooOld = await createTgUser({ createdAt: hoursAgo(100) });

    const rows = await findFreshUsersWithoutOrders(db, window);
    const ids = rows.map((r) => r.userId);
    expect(ids).not.toContain(web.id);
    expect(ids).not.toContain(opted.id);
    expect(ids).not.toContain(tooFresh.id);
    expect(ids).not.toContain(tooOld.id);
  });

  it('пользователь с уже отправленным опросом исключается', async () => {
    const user = await createTgUser({ createdAt: hoursAgo(30) });
    await claimFunnelSend(db, { userId: user.id, kind: 'start_survey' });

    const rows = await findFreshUsersWithoutOrders(db, window);
    expect(rows.map((r) => r.userId)).not.toContain(user.id);
  });
});

describe('findCompletedOrdersForRating (msg3) — окно +1 час', () => {
  const window = { from: hoursAgo(24), to: hoursAgo(1) };

  it('заказ, завершённый в окне, попадает; свежее часа и старше суток — нет', async () => {
    const user = await createTgUser();
    const order = await createOrderInStatus(user.id, 'completed', hoursAgo(2));

    const hot = await createTgUser();
    await createOrderInStatus(hot.id, 'completed', new Date(Date.now() - 10 * 60 * 1000));

    const old = await createTgUser();
    await createOrderInStatus(old.id, 'completed', hoursAgo(48));

    const rows = await findCompletedOrdersForRating(db, window);
    const orderIds = rows.map((r) => r.orderId);
    expect(orderIds).toContain(order.id);
    expect(rows.find((r) => r.orderId === order.id)?.userId).toBe(user.id);
    expect(rows.map((r) => r.userId)).not.toContain(hot.id);
    expect(rows.map((r) => r.userId)).not.toContain(old.id);
  });

  it('заказ, по которому оценка уже спрашивалась, исключается', async () => {
    const user = await createTgUser();
    const order = await createOrderInStatus(user.id, 'completed', hoursAgo(2));
    await claimFunnelSend(db, { userId: user.id, kind: 'order_rating', orderId: order.id });

    const rows = await findCompletedOrdersForRating(db, window);
    expect(rows.map((r) => r.orderId)).not.toContain(order.id);
  });
});

describe('findRatedUsersForReferralNudge (msg4)', () => {
  const window = { from: hoursAgo(96), to: hoursAgo(48) };

  async function rate(userId: string, score: number, createdAt: Date) {
    const order = await createOrderInStatus(userId, 'completed', null);
    await db.insert(schema.clientFeedback).values({
      userId,
      orderId: order.id,
      kind: 'order_rating',
      score,
      createdAt,
    });
  }

  it('оценка ≥4 в окне попадает; оценка 3 — нет; вне окна — нет', async () => {
    const happy = await createTgUser();
    await rate(happy.id, 4, hoursAgo(50));

    const meh = await createTgUser();
    await rate(meh.id, 3, hoursAgo(50));

    const late = await createTgUser();
    await rate(late.id, 5, hoursAgo(120));

    const rows = await findRatedUsersForReferralNudge(db, window);
    const ids = rows.map((r) => r.userId);
    expect(ids).toContain(happy.id);
    expect(ids).not.toContain(meh.id);
    expect(ids).not.toContain(late.id);
  });

  it('уже получивший касание — раз за жизнь — исключается', async () => {
    const user = await createTgUser();
    await rate(user.id, 5, hoursAgo(50));
    await claimFunnelSend(db, { userId: user.id, kind: 'referral_nudge' });

    const rows = await findRatedUsersForReferralNudge(db, window);
    expect(rows.map((r) => r.userId)).not.toContain(user.id);
  });

  it('две оценки ≥4 в окне дают ОДНУ строку клиента (DISTINCT)', async () => {
    const user = await createTgUser();
    await rate(user.id, 5, hoursAgo(50));
    await rate(user.id, 4, hoursAgo(60));

    const rows = await findRatedUsersForReferralNudge(db, window);
    expect(rows.filter((r) => r.userId === user.id)).toHaveLength(1);
  });
});

describe('RLS на новых таблицах', () => {
  it('funnel_sends и client_feedback — deny-by-default (RLS включён, политик нет)', async () => {
    const rows = await db.execute(
      sql`SELECT c.relname, c.relrowsecurity,
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
          FROM pg_class c
          WHERE c.relname IN ('funnel_sends', 'client_feedback')`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows as unknown as { relrowsecurity: boolean; policies: number | string }[]) {
      expect(row.relrowsecurity).toBe(true);
      expect(Number(row.policies)).toBe(0);
    }
  });
});
