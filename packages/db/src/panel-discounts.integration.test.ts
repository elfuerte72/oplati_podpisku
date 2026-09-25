import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import * as schema from './schema.ts';
import type { DB } from './index.ts';
import { createTestDb } from './test-harness.ts';
import { createDraftOrder } from './repositories/orders.ts';
import { getOrderDetailForPanel, listHoldsForPanel } from './repositories/panel.ts';
import { upsertPromoCode } from './repositories/promo-codes.ts';
import { revenueSummary, type AnalyticsRange } from './repositories/analytics-panel.ts';
import { dailyPromoDiscounts } from './repositories/daily-report.ts';

/**
 * Скидки заказа на экранах панели (аудит CRM 2026-09-17, тикет 05) — РЕАЛЬНЫЙ
 * Postgres (PGlite): «живость» промокода и баллов считается общими SQL-правилами
 * (`livePromoRedemptionSql`, `liveRedemptionSql`), и подменой их не проверить.
 *
 * База своя, а не общая с `analytics-panel`: сверка «выручка + скидки = полные
 * цены» требует, чтобы в окне не было чужих фикстур.
 */

let db: DB;

/** Время оплаты заказов карточки — вне окна сверки «Отчётов» ниже. */
const IN_RANGE = '2026-05-02T12:00:00.000Z';

let seq = 0;
let promoCodeId: string;

async function makeUser(): Promise<string> {
  const rows = await db
    .insert(schema.users)
    .values({ telegramId: `tg-pd-${++seq}` })
    .returning({ id: schema.users.id });
  return rows[0]!.id;
}

async function makeOrder(input: {
  userId: string;
  amountKopecks: number;
  status: string;
  paidAt?: string | null;
}): Promise<{ id: string; shortId: string }> {
  const order = await createDraftOrder(db, {
    userId: input.userId,
    status: 'draft',
    customServiceDescription: 'скидки на экранах',
    amountRub: input.amountKopecks,
    originalAmount: 3000,
    originalCurrency: 'USD',
  });
  await db.execute(sql`
    UPDATE orders SET status = ${input.status}::order_status,
      paid_at = ${input.paidAt ?? null}::timestamptz
    WHERE id = ${order.id}
  `);
  return { id: order.id, shortId: order.shortId };
}

async function addPayment(
  orderId: string,
  amountKopecks: number,
  status: 'pending' | 'succeeded' | 'failed',
  completedAt: string | null = null,
): Promise<void> {
  await db.insert(schema.payments).values({
    orderId,
    provider: 'freekassa',
    providerRef: `pd-ref-${++seq}`,
    amountRub: amountKopecks,
    status,
    completedAt: completedAt ? new Date(completedAt) : null,
  });
}

async function addPromo(
  orderId: string,
  userId: string,
  discountKopecks: number,
  status: 'reserved' | 'spent' | 'released',
  settledAt: string | null = null,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO promo_redemptions
      (order_id, promo_code_id, user_id, discount_usd_cents, discount_kopecks, rate_kopecks, status, settled_at)
    VALUES (${orderId}, ${promoCodeId}, ${userId}, 500, ${discountKopecks}, 810000,
            ${status}::promo_redemption_status, ${settledAt}::timestamptz)
  `);
}

async function addBonus(
  orderId: string,
  userId: string,
  discountKopecks: number,
  status: 'reserved' | 'spent' | 'released',
  settledAt: string | null = null,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO referral_redemptions
      (order_id, user_id, amount_usd_cents, discount_kopecks, rate_kopecks, status, settled_at)
    VALUES (${orderId}, ${userId}, 370, ${discountKopecks}, 810000,
            ${status}::referral_redemption_status, ${settledAt}::timestamptz)
  `);
}

beforeAll(async () => {
  ({ db } = await createTestDb());
  const code = await upsertPromoCode(db, {
    code: 'ДАРЛИНГ',
    discountUsdCents: 500,
    capToMargin: false,
    minOrderAmountKopecks: null,
    perUserLimit: 1,
    maxRedemptions: null,
    startsAt: null,
    expiresAt: null,
    isActive: true,
    note: null,
  });
  promoCodeId = code.id;
});

describe('карточка заказа: промокод и баллы', () => {
  it('3 000 ₽, промокод −405 ₽, баллы −300 ₽ → обе скидки и счёт 2 295 ₽ в платежах', async () => {
    const userId = await makeUser();
    const order = await makeOrder({ userId, amountKopecks: 3000_00, status: 'completed', paidAt: IN_RANGE });
    await addPromo(order.id, userId, 405_00, 'spent', IN_RANGE);
    await addBonus(order.id, userId, 300_00, 'spent', IN_RANGE);
    await addPayment(order.id, 2295_00, 'succeeded', IN_RANGE);

    const detail = await getOrderDetailForPanel(db, order.shortId);

    expect(detail?.promo).toEqual({ code: 'ДАРЛИНГ', discountKopecks: 405_00 });
    expect(detail?.bonus).toMatchObject({ discountKopecks: 300_00, live: true });
    expect(detail?.payments.map((p) => p.amountRubKopecks)).toEqual([2295_00]);
  });

  it('только промокод: баллов нет, промокод есть', async () => {
    const userId = await makeUser();
    const order = await makeOrder({ userId, amountKopecks: 3000_00, status: 'pending_payment' });
    await addPromo(order.id, userId, 405_00, 'reserved');
    await addPayment(order.id, 2595_00, 'pending');

    const detail = await getOrderDetailForPanel(db, order.shortId);

    expect(detail?.promo).toEqual({ code: 'ДАРЛИНГ', discountKopecks: 405_00 });
    expect(detail?.bonus).toBeNull();
  });

  it('протухший заказ без платежа: резерв вернулся правилом — ни промокода, ни «живых» баллов', async () => {
    const userId = await makeUser();
    const order = await makeOrder({ userId, amountKopecks: 3000_00, status: 'expired' });
    await addPromo(order.id, userId, 405_00, 'reserved');
    await addBonus(order.id, userId, 300_00, 'reserved');

    const detail = await getOrderDetailForPanel(db, order.shortId);

    expect(detail?.promo).toBeNull();
    // Строка баллов возвращается (кнопке возврата нужен статус), но не «живая».
    expect(detail?.bonus).toMatchObject({ status: 'reserved', live: false });
  });

  it('оплата пришла после захоронения (paid_after_terminal): резерв остаётся живым', async () => {
    const userId = await makeUser();
    const order = await makeOrder({ userId, amountKopecks: 3000_00, status: 'expired' });
    await addPromo(order.id, userId, 405_00, 'reserved');
    await addBonus(order.id, userId, 300_00, 'reserved');
    await addPayment(order.id, 2295_00, 'succeeded', IN_RANGE);

    const detail = await getOrderDetailForPanel(db, order.shortId);

    expect(detail?.promo).not.toBeNull();
    expect(detail?.bonus?.live).toBe(true);
  });

  it('возвращённый оператором промокод на карточке не показывается', async () => {
    const userId = await makeUser();
    const order = await makeOrder({ userId, amountKopecks: 3000_00, status: 'failed', paidAt: IN_RANGE });
    await addPromo(order.id, userId, 405_00, 'released');

    expect((await getOrderDetailForPanel(db, order.shortId))?.promo).toBeNull();
  });
});

describe('проверка платежей: сумма СЧЁТА', () => {
  it('строка холда несёт сумму платежа, а не цену заказа', async () => {
    const userId = await makeUser();
    const order = await makeOrder({ userId, amountKopecks: 3000_00, status: 'payment_review' });
    await addPromo(order.id, userId, 405_00, 'reserved');
    await addPayment(order.id, 2595_00, 'pending');

    const { items } = await listHoldsForPanel(db);
    const row = items.find((i) => i.orderId === order.id);

    expect(row).toMatchObject({
      amountRubKopecks: 3000_00,
      promoDiscountKopecks: 405_00,
      paymentAmountRubKopecks: 2595_00,
    });
  });
});

describe('«Отчёты»: выручка + скидки = полные цены оплаченных заказов', () => {
  it('сходится на заказе со скидками и заказе без них', async () => {
    // Своё окно: заказы выше тоже оплачены в RANGE, поэтому сверку считаем
    // по отдельному периоду, где лежат только эти два заказа.
    const window: AnalyticsRange = {
      since: '2026-06-01T00:00:00.000Z',
      until: '2026-06-02T00:00:00.000Z',
    };
    const at = '2026-06-01T10:00:00.000Z';
    const userId = await makeUser();

    const discounted = await makeOrder({ userId, amountKopecks: 3000_00, status: 'completed', paidAt: at });
    await addPromo(discounted.id, userId, 405_00, 'spent', at);
    await addBonus(discounted.id, userId, 300_00, 'spent', at);
    await addPayment(discounted.id, 2295_00, 'succeeded', at);

    const plain = await makeOrder({ userId, amountKopecks: 1000_00, status: 'completed', paidAt: at });
    await addPayment(plain.id, 1000_00, 'succeeded', at);

    const summary = await revenueSummary(db, window);
    const promo = await dailyPromoDiscounts(db, window);
    const fullPrices = 3000_00 + 1000_00;

    expect(summary.amountKopecks + summary.bonusRedeemedKopecks + promo.kopecks).toBe(fullPrices);
    expect(promo).toEqual({ orders: 1, kopecks: 405_00 });
    // Средний чек — по ПОЛНОЙ цене (подпись экрана «по полной цене»).
    expect(summary.averageKopecks).toBe(fullPrices / 2);
  });
});
