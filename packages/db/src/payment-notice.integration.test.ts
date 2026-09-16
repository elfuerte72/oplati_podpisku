import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import * as schema from './schema.ts';
import type { DB } from './index.ts';
import { createTestDb } from './test-harness.ts';
import { createDraftOrder } from './repositories/orders.ts';
import { findPaidOrderNotice } from './repositories/payment-notice.ts';
import type { OrderParameters } from '@oplati/types';

/**
 * Карточка «Оплата принята» — реальный Postgres (PGlite): три подзапроса,
 * lateral-join платежа и список статусов покупки подменой не проверить.
 */

let db: DB;
let seq = 0;

async function makeUser(over: Partial<typeof schema.users.$inferInsert> = {}) {
  const rows = await db
    .insert(schema.users)
    .values({ telegramId: `tg-pn-${++seq}`, ...over })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('users insert');
  return row;
}

async function makeOrder(input: {
  userId: string;
  serviceId?: string | null;
  amountKopecks?: number;
  feeKopecks?: number;
  parameters?: OrderParameters;
}) {
  return createDraftOrder(db, {
    userId: input.userId,
    status: 'draft',
    serviceId: input.serviceId ?? null,
    customServiceDescription: input.serviceId ? null : 'своя подписка',
    amountRub: input.amountKopecks ?? 200_000,
    originalAmount: 1599,
    originalCurrency: 'USD',
    ...(input.feeKopecks !== undefined ? { cardIssueFeeKopecks: input.feeKopecks } : {}),
    ...(input.parameters ? { parameters: input.parameters } : {}),
  });
}

async function setStatus(orderId: string, status: string, paidAt?: Date) {
  await db.execute(
    sql`UPDATE orders SET status = ${status}::order_status,
        paid_at = ${paidAt ? paidAt.toISOString() : null}::timestamptz WHERE id = ${orderId}`,
  );
}

beforeAll(async () => {
  ({ db } = await createTestDb());
});

describe('findPaidOrderNotice', () => {
  it('собирает заказ, клиента, сервис, скидку и платёж одной карточкой', async () => {
    const user = await makeUser({ displayName: 'Мария', telegramUsername: 'maria_pays' });
    const [service] = await db
      .insert(schema.services)
      .values({ slug: `netflix-${++seq}`, name: 'Netflix', category: 'test' })
      .returning();
    if (!service) throw new Error('services insert');

    const order = await makeOrder({
      userId: user.id,
      serviceId: service.id,
      amountKopecks: 200_000,
      feeKopecks: 32_400,
      parameters: { tierName: 'Standard' },
    });
    await setStatus(order.id, 'paid', new Date('2026-09-16T10:00:00Z'));
    await db.insert(schema.payments).values({
      orderId: order.id,
      provider: 'freekassa',
      providerRef: `fk-${seq}`,
      amountRub: 159_500,
      status: 'succeeded',
      recoveredViaPolling: true,
      completedAt: new Date('2026-09-16T10:00:05Z'),
    });
    await db.insert(schema.referralRedemptions).values({
      orderId: order.id,
      userId: user.id,
      amountUsdCents: 500,
      discountKopecks: 40_500,
      rateKopecks: 8_100,
      status: 'spent',
    });
    // Вторая состоявшаяся покупка и один протухший заказ: считаются только первые.
    const earlier = await makeOrder({ userId: user.id, serviceId: service.id });
    await setStatus(earlier.id, 'completed', new Date('2026-08-01T10:00:00Z'));
    const expired = await makeOrder({ userId: user.id, serviceId: service.id });
    await setStatus(expired.id, 'expired');

    const notice = await findPaidOrderNotice(db, order.id);
    expect(notice).not.toBeNull();
    expect(notice).toMatchObject({
      shortId: order.shortId,
      status: 'paid',
      amountKopecks: 200_000,
      cardIssueFeeKopecks: 32_400,
      promoDiscountKopecks: 0,
      bonusDiscountKopecks: 40_500,
      serviceName: 'Netflix',
      tierName: 'Standard',
      originalAmount: 1599,
      originalCurrency: 'USD',
      customDescription: null,
      client: {
        userId: user.id,
        displayName: 'Мария',
        telegramUsername: 'maria_pays',
        telegramId: user.telegramId,
        purchases: 2,
      },
      payment: { provider: 'freekassa', amountKopecks: 159_500, recoveredViaPolling: true },
    });
    expect(notice?.paidAt?.toISOString()).toBe('2026-09-16T10:00:00.000Z');
    expect(notice?.payment?.completedAt?.toISOString()).toBe('2026-09-16T10:00:05.000Z');
    expect(notice?.client.since).toBeInstanceOf(Date);
  });

  it('заказ вне каталога без платежа: описание клиента, платёж null, покупка первая', async () => {
    const user = await makeUser();
    const order = await makeOrder({ userId: user.id, serviceId: null });
    await setStatus(order.id, 'paid', new Date());

    const notice = await findPaidOrderNotice(db, order.id);
    expect(notice).toMatchObject({
      serviceName: null,
      customDescription: 'своя подписка',
      payment: null,
      client: { purchases: 1, displayName: null, telegramUsername: null },
    });
  });

  it('освобождённое списание скидкой не считается', async () => {
    const user = await makeUser();
    const order = await makeOrder({ userId: user.id, serviceId: null });
    await setStatus(order.id, 'paid', new Date());
    await db.insert(schema.referralRedemptions).values({
      orderId: order.id,
      userId: user.id,
      amountUsdCents: 500,
      discountKopecks: 40_500,
      rateKopecks: 8_100,
      status: 'released',
    });
    const notice = await findPaidOrderNotice(db, order.id);
    expect(notice?.bonusDiscountKopecks).toBe(0);
  });

  it('неизвестный заказ → null', async () => {
    expect(await findPaidOrderNotice(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
