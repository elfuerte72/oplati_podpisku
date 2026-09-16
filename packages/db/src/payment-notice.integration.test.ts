import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import type { OrderParameters } from '@oplati/types';

import * as schema from './schema.ts';
import type { DB } from './index.ts';
import { createTestDb } from './test-harness.ts';
import { createDraftOrder } from './repositories/orders.ts';
import { findPaidOrderNotice } from './repositories/payment-notice.ts';

/**
 * Карточка «Оплата принята» — реальный Postgres (PGlite): подзапросы скидок с
 * общими условиями «списание живо», join платежа и список статусов покупки
 * подменой не проверить.
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

async function succeededPayment(orderId: string, amountKopecks: number, over: { recoveredViaPolling?: boolean } = {}) {
  await db.insert(schema.payments).values({
    orderId,
    provider: 'freekassa',
    providerRef: `fk-${++seq}`,
    amountRub: amountKopecks,
    status: 'succeeded',
    recoveredViaPolling: over.recoveredViaPolling ?? false,
    completedAt: new Date(),
  });
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
    await succeededPayment(order.id, 159_500, { recoveredViaPolling: true });
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
        displayName: 'Мария',
        telegramUsername: 'maria_pays',
        telegramId: user.telegramId,
        purchases: 2,
      },
      payment: { provider: 'freekassa', amountKopecks: 159_500, recoveredViaPolling: true },
    });
    expect(notice?.client.since).toBeInstanceOf(Date);
  });

  it('заказ вне каталога: описание клиента; покупка первая', async () => {
    const user = await makeUser();
    const order = await makeOrder({ userId: user.id, serviceId: null });
    await setStatus(order.id, 'paid', new Date());
    await succeededPayment(order.id, 200_000);

    const notice = await findPaidOrderNotice(db, order.id);
    expect(notice).toMatchObject({
      serviceName: null,
      customDescription: 'своя подписка',
      payment: { provider: 'freekassa', amountKopecks: 200_000, recoveredViaPolling: false },
      client: { purchases: 1, displayName: null, telegramUsername: null },
    });
  });

  it('этот заказ считается покупкой, даже если выпуск карты уже успел уронить его в failed', async () => {
    const user = await makeUser();
    const order = await makeOrder({ userId: user.id, serviceId: null });
    await setStatus(order.id, 'failed', new Date());
    await succeededPayment(order.id, 200_000);
    const notice = await findPaidOrderNotice(db, order.id);
    expect(notice?.status).toBe('failed');
    expect(notice?.client.purchases).toBe(1);
  });

  it('освобождённое списание скидкой не считается', async () => {
    const user = await makeUser();
    const order = await makeOrder({ userId: user.id, serviceId: null });
    await setStatus(order.id, 'paid', new Date());
    await succeededPayment(order.id, 200_000);
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

  it('заказ без успешного платежа и неизвестный заказ → null', async () => {
    const user = await makeUser();
    const order = await makeOrder({ userId: user.id, serviceId: null });
    await setStatus(order.id, 'paid', new Date());
    expect(await findPaidOrderNotice(db, order.id)).toBeNull();
    expect(await findPaidOrderNotice(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
