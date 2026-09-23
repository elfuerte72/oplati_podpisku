import { beforeAll, describe, expect, it } from 'vitest';

import * as schema from './schema.ts';
import type { DB } from './index.ts';
import { createTestDb } from './test-harness.ts';
import {
  appendOrderEvent,
  createDraftOrder,
  findOrderIdsWithEvent,
} from './repositories/orders.ts';

/**
 * Пакетная выборка «у каких заказов есть событие X» (трек miniapp-tabs,
 * тикет 06): вкладка «Карта» решает по признаку `subscription_activated`,
 * показывать ли «Остался один шаг». Запрос на заказ превратил бы снапшот
 * кабинета в N+1, поэтому — одним запросом по списку.
 */

let db: DB;
let seq = 0;

async function makeUser(): Promise<string> {
  const rows = await db
    .insert(schema.users)
    .values({ telegramId: `tg-events-batch-${++seq}` })
    .returning({ id: schema.users.id });
  return rows[0]!.id;
}

async function makeOrder(userId: string): Promise<string> {
  const order = await createDraftOrder(db, {
    userId,
    status: 'completed',
    customServiceDescription: 'events-batch',
    amountRub: 100_000,
  });
  return order.id;
}

beforeAll(async () => {
  ({ db } = await createTestDb());
});

describe('findOrderIdsWithEvent', () => {
  it('возвращает ровно те заказы из списка, у которых событие есть', async () => {
    const userId = await makeUser();
    const marked = await makeOrder(userId);
    const unmarked = await makeOrder(userId);
    await appendOrderEvent(db, {
      orderId: marked,
      eventType: 'subscription_activated',
      actorType: 'user',
      actorId: userId,
    });

    const found = await findOrderIdsWithEvent(db, {
      orderIds: [marked, unmarked],
      eventType: 'subscription_activated',
    });

    expect(found).toEqual(new Set([marked]));
  });

  it('событие другого типа не считается', async () => {
    const userId = await makeUser();
    const orderId = await makeOrder(userId);
    await appendOrderEvent(db, {
      orderId,
      eventType: 'payment_issue_reported',
      actorType: 'user',
      actorId: userId,
    });

    const found = await findOrderIdsWithEvent(db, {
      orderIds: [orderId],
      eventType: 'subscription_activated',
    });

    expect(found.size).toBe(0);
  });

  it('заказы вне списка не возвращаются, даже с событием', async () => {
    const userId = await makeUser();
    const outside = await makeOrder(userId);
    const inside = await makeOrder(userId);
    await appendOrderEvent(db, {
      orderId: outside,
      eventType: 'subscription_activated',
      actorType: 'user',
      actorId: userId,
    });

    const found = await findOrderIdsWithEvent(db, {
      orderIds: [inside],
      eventType: 'subscription_activated',
    });

    expect(found.size).toBe(0);
  });

  it('повторная отметка не дублирует заказ', async () => {
    const userId = await makeUser();
    const orderId = await makeOrder(userId);
    for (let i = 0; i < 2; i++) {
      await appendOrderEvent(db, {
        orderId,
        eventType: 'subscription_activated',
        actorType: 'user',
        actorId: userId,
      });
    }

    const found = await findOrderIdsWithEvent(db, {
      orderIds: [orderId],
      eventType: 'subscription_activated',
    });

    expect([...found]).toEqual([orderId]);
  });

  it('пустой список — пустой ответ без запроса в базу', async () => {
    const found = await findOrderIdsWithEvent(db, {
      orderIds: [],
      eventType: 'subscription_activated',
    });
    expect(found.size).toBe(0);
  });
});
