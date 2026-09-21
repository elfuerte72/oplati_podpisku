import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import type { BillingAddress } from '@oplati/types';

import * as schema from './schema.ts';
import type { DB } from './index.ts';
import { createTestDb } from './test-harness.ts';
import { getOrAssignUserBillingAddress, getUserBillingAddress } from './repositories/users.ts';

/**
 * Закрепление billing-адреса за клиентом на реальном Postgres (миграция 0048).
 *
 * Проверяем то, ради чего адрес хранится: на первом заказе он закрепляется, на
 * следующих — возвращается ТОТ ЖЕ, какой бы кандидат ни пришёл.
 */

let db: DB;
let seq = 0;

const PORTLAND: BillingAddress = {
  streetLine1: '801 SW 10th Ave',
  city: 'Portland',
  state: 'Oregon',
  stateCode: 'OR',
  postalCode: '97205',
  country: 'United States',
  countryCode: 'US',
};
const MISSOULA: BillingAddress = {
  streetLine1: '455 E Main St',
  city: 'Missoula',
  state: 'Montana',
  stateCode: 'MT',
  postalCode: '59802',
  country: 'United States',
  countryCode: 'US',
};

async function makeUser(): Promise<string> {
  const rows = await db
    .insert(schema.users)
    .values({ telegramId: `tg-billing-${++seq}` })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('ожидалась строка: users insert');
  return row.id;
}

beforeAll(async () => {
  ({ db } = await createTestDb());
});

describe('getOrAssignUserBillingAddress', () => {
  it('у нового клиента адреса нет', async () => {
    expect(await getUserBillingAddress(db, await makeUser())).toBeNull();
  });

  it('первый заказ закрепляет кандидата', async () => {
    const userId = await makeUser();

    expect(await getOrAssignUserBillingAddress(db, { userId, candidate: PORTLAND })).toEqual(PORTLAND);
    expect(await getUserBillingAddress(db, userId)).toEqual(PORTLAND);
  });

  it('следующий заказ возвращает ЗАКРЕПЛЁННЫЙ адрес, а не нового кандидата', async () => {
    const userId = await makeUser();
    await getOrAssignUserBillingAddress(db, { userId, candidate: PORTLAND });

    // У сервиса аккаунт клиента привязан к первому адресу — второй случайный
    // кандидат обязан проиграть.
    expect(await getOrAssignUserBillingAddress(db, { userId, candidate: MISSOULA })).toEqual(PORTLAND);
    expect(await getUserBillingAddress(db, userId)).toEqual(PORTLAND);
  });

  it('два одновременных выпуска одному клиенту сходятся на ОДНОМ адресе', async () => {
    const userId = await makeUser();

    const [a, b] = await Promise.all([
      getOrAssignUserBillingAddress(db, { userId, candidate: PORTLAND }),
      getOrAssignUserBillingAddress(db, { userId, candidate: MISSOULA }),
    ]);

    expect(a).toEqual(b);
    expect(await getUserBillingAddress(db, userId)).toEqual(a);
  });

  it('адрес одного клиента не задевает другого', async () => {
    const first = await makeUser();
    const second = await makeUser();
    await getOrAssignUserBillingAddress(db, { userId: first, candidate: PORTLAND });

    expect(await getOrAssignUserBillingAddress(db, { userId: second, candidate: MISSOULA })).toEqual(MISSOULA);
    expect(await getUserBillingAddress(db, first)).toEqual(PORTLAND);
  });

  it('клиента нет — null, а не выдуманный успех', async () => {
    expect(
      await getOrAssignUserBillingAddress(db, {
        userId: '00000000-0000-4000-8000-000000000000',
        candidate: PORTLAND,
      }),
    ).toBeNull();
  });

  it('строка, не прошедшая схему (базу правили руками), читается как null', async () => {
    const userId = await makeUser();
    await db.execute(sql`
      UPDATE users SET billing_address = '{"city":"Nowhere"}'::jsonb WHERE id = ${userId}
    `);

    expect(await getUserBillingAddress(db, userId)).toBeNull();
    // Кандидат битую строку НЕ перезаписывает: COALESCE видит «адрес есть».
    // Вызывающий получает null и сам выдаёт адрес из пула, с сигналом в Sentry.
    expect(await getOrAssignUserBillingAddress(db, { userId, candidate: PORTLAND })).toBeNull();
  });

  it('закрепление не двигает updated_at — это наш фоновый шаг, а не действие клиента', async () => {
    const userId = await makeUser();
    const before = await db.select().from(schema.users).where(eq(schema.users.id, userId));

    await getOrAssignUserBillingAddress(db, { userId, candidate: PORTLAND });

    const after = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(after[0]?.updatedAt).toEqual(before[0]?.updatedAt);
  });
});
