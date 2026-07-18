import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';

import { OrderTransitionError } from '@oplati/types';

import * as schema from './schema.ts';
import type { DB } from './index.ts';
import {
  claimPaymentSucceeded,
  claimPaymentTerminal,
  findPendingPaymentByOrderId,
  upsertPaymentByProviderRef,
} from './repositories/payments.ts';
import {
  createDraftOrder,
  findExpiredPendingOrders,
  transitionOrderDetailed,
} from './repositories/orders.ts';
import { consumeLinkToken, createLinkToken } from './repositories/link-tokens.ts';
import { getOrCreateUserByTelegramId } from './repositories/users.ts';
import {
  getReferralBalanceUsdCents,
  insertCommissionAccruals,
} from './repositories/referral-accruals.ts';
import {
  createReferralPayout,
  transitionReferralPayout,
} from './repositories/referral-cabinet.ts';
import { idleAgedActiveCards, syncCardBalance, updateBalance } from './repositories/cards.ts';

/**
 * Интеграционные тесты репозиториев на РЕАЛЬНОМ Postgres (PGlite, WASM) с
 * реальными миграциями из `migrations/`. Закрывают главный пробел аудита
 * тестирования: денежные SQL-гарантии (условные claim'ы, FOR UPDATE, частичные
 * unique, транзакция merge) до этого исполнялись только моками, которые
 * переизобретали семантику БД.
 */

// drizzle-драйверы расходятся в форме результата `db.execute()`: postgres-js
// возвращает сами строки (RowList), PGlite — { rows }. Репозитории написаны под
// postgres-js и индексируют результат напрямую, поэтому в тестах нормализуем
// execute (и рекурсивно — tx внутри transaction) до массива строк.
function normalizeExecute<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === 'execute') {
        return async (query: unknown) => {
          const orig = Reflect.get(t, prop, receiver) as (q: unknown) => Promise<unknown>;
          const res = await orig.call(t, query);
          return Array.isArray(res) ? res : (res as { rows: unknown[] }).rows;
        };
      }
      if (prop === 'transaction') {
        const orig = Reflect.get(t, prop, receiver) as (
          fn: (tx: object) => Promise<unknown>,
          cfg?: unknown,
        ) => Promise<unknown>;
        return (fn: (tx: object) => Promise<unknown>, cfg?: unknown) =>
          orig.call(t, (tx: object) => fn(normalizeExecute(tx)), cfg);
      }
      const value: unknown = Reflect.get(t, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });
}

let db: DB;
let seq = 0;

function firstOf<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`ожидалась строка: ${what}`);
  return row;
}

// drizzle оборачивает ошибки БД в DrizzleQueryError — оригинал Postgres в cause.
function pgErrorMatches(err: unknown, re: RegExp): boolean {
  const chain: unknown[] = [err];
  if (typeof err === 'object' && err !== null && 'cause' in err) {
    chain.push((err as { cause?: unknown }).cause);
  }
  return chain.some(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      re.test((e as { message?: string }).message ?? ''),
  );
}

async function makeUser(over: Partial<typeof schema.users.$inferInsert> = {}) {
  const rows = await db
    .insert(schema.users)
    .values({ telegramId: `tg-${++seq}`, ...over })
    .returning();
  return firstOf(rows, 'users insert');
}

async function makeOrderWithPendingPayment(params: {
  userId: string;
  amountRub?: number;
  expiresAt?: Date;
}) {
  const order = await createDraftOrder(db, {
    userId: params.userId,
    status: 'pending_payment',
    // CHECK orders_service_or_custom требует service ИЛИ описание.
    customServiceDescription: 'integration-test order',
    amountRub: params.amountRub ?? 50000,
    originalAmount: 500,
    originalCurrency: 'USD',
    expiresAt: params.expiresAt ?? null,
  });
  const { payment } = await upsertPaymentByProviderRef(db, {
    orderId: order.id,
    provider: 'loveandpay',
    providerRef: `inv-${++seq}`,
    amountRub: params.amountRub ?? 50000,
  });
  return { order, payment };
}

beforeAll(async () => {
  const client = new PGlite();
  // Миграции гоняем через client.exec (simple query protocol): drizzle-migrator
  // шлёт чанки prepared statement'ами, а ранние hand-written миграции (0001 RLS
  // и т.п.) мультистейтментные без `--> statement-breakpoint` — редактировать
  // применённые миграции нельзя. exec исполняет файл как есть.
  // Supabase-роли, на которые ссылаются RLS-политики/GRANT'ы миграций.
  await client.exec(
    'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;',
  );
  const dir = join(import.meta.dirname, '..', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(join(dir, file), 'utf8'));
  }
  const raw = drizzle(client, { schema });
  // У PGlite-драйвера другой HKT в типах, но runtime-API совпадает с
  // postgres-js — обоснованное сужение для тестовой обвязки.
  db = normalizeExecute(raw) as unknown as DB;
});

describe('claimPaymentSucceeded (атомарный claim pending→succeeded)', () => {
  it('из конкурентных вызовов строку получает ровно один; повтор — null', async () => {
    const user = await makeUser();
    const { payment } = await makeOrderWithPendingPayment({ userId: user.id });

    const results = await Promise.all([
      claimPaymentSucceeded(db, { paymentId: payment.id }),
      claimPaymentSucceeded(db, { paymentId: payment.id }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    expect(await claimPaymentSucceeded(db, { paymentId: payment.id })).toBeNull();

    const rows = await db.select().from(schema.payments).where(eq(schema.payments.id, payment.id));
    expect(firstOf(rows, 'payment').status).toBe('succeeded');
  });

  it('C1: сбой в общей транзакции ПОСЛЕ claim откатывает и claim — платёж остаётся pending', async () => {
    const user = await makeUser();
    const { payment } = await makeOrderWithPendingPayment({ userId: user.id });

    // Сценарий processInvoicePaid: claim прошёл, а переход заказа упал
    // транзиентно. До фикса аудита C1 claim жил отдельно и «съедался» —
    // payment застревал в succeeded при неоплаченном заказе без recovery.
    await expect(
      db.transaction(async (tx) => {
        const claimed = await claimPaymentSucceeded(tx, { paymentId: payment.id });
        expect(claimed).not.toBeNull();
        throw new Error('transient db failure');
      }),
    ).rejects.toThrow('transient db failure');

    const rows = await db.select().from(schema.payments).where(eq(schema.payments.id, payment.id));
    expect(firstOf(rows, 'payment').status).toBe('pending');

    // После отката claim доступен повторно (poll-payment дообработает).
    expect(await claimPaymentSucceeded(db, { paymentId: payment.id })).not.toBeNull();
  });
});

describe('claimPaymentTerminal (атомарный claim pending→failed)', () => {
  it('F-05: сбой в общей транзакции ПОСЛЕ claim откатывает и claim — платёж остаётся pending', async () => {
    const user = await makeUser();
    const { payment } = await makeOrderWithPendingPayment({ userId: user.id });

    // Сценарий processInvoiceTerminal (симметричен C1): terminal claim прошёл,
    // а переход заказа (expired/cancelled) упал транзиентно. До фикса F-05 claim
    // коммитился отдельно — payment застревал в failed при заказе в
    // pending_payment, а повтор webhook'а вечно получал idempotent_skip.
    await expect(
      db.transaction(async (tx) => {
        const claimed = await claimPaymentTerminal(tx, payment.id);
        expect(claimed).not.toBeNull();
        throw new Error('transient db failure');
      }),
    ).rejects.toThrow('transient db failure');

    const rows = await db.select().from(schema.payments).where(eq(schema.payments.id, payment.id));
    expect(firstOf(rows, 'payment').status).toBe('pending');

    // Ретрай L&P/poll доигрывает оба шага заново.
    expect(await claimPaymentTerminal(db, payment.id)).not.toBeNull();
  });

  it('после успешной транзакции claim идемпотентен (повтор → null)', async () => {
    const user = await makeUser();
    const { payment } = await makeOrderWithPendingPayment({ userId: user.id });

    await db.transaction(async (tx) => {
      expect(await claimPaymentTerminal(tx, payment.id)).not.toBeNull();
    });

    expect(await claimPaymentTerminal(db, payment.id)).toBeNull();
    const rows = await db.select().from(schema.payments).where(eq(schema.payments.id, payment.id));
    expect(firstOf(rows, 'payment').status).toBe('failed');
  });
});

describe('upsertPaymentByProviderRef (идемпотентность webhook)', () => {
  it('повторный upsert с тем же (provider, providerRef) не создаёт дубль', async () => {
    const user = await makeUser();
    const order = await createDraftOrder(db, {
      userId: user.id,
      status: 'pending_payment',
      customServiceDescription: 'integration-test order',
    });
    const ref = `inv-${++seq}`;

    const a = await upsertPaymentByProviderRef(db, {
      orderId: order.id,
      provider: 'loveandpay',
      providerRef: ref,
      amountRub: 10000,
    });
    const b = await upsertPaymentByProviderRef(db, {
      orderId: order.id,
      provider: 'loveandpay',
      providerRef: ref,
      amountRub: 10000,
    });

    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(false);
    expect(b.payment.id).toBe(a.payment.id);
  });

  it('второй PENDING-платёж на тот же заказ блокируется частичным unique (гонка confirm_order)', async () => {
    const user = await makeUser();
    const { order } = await makeOrderWithPendingPayment({ userId: user.id });

    await expect(
      upsertPaymentByProviderRef(db, {
        orderId: order.id,
        provider: 'loveandpay',
        providerRef: `inv-${++seq}`, // другой инвойс — конфликт не по (provider, ref)
        amountRub: 10000,
      }),
    ).rejects.toSatisfy((e: unknown) =>
      pgErrorMatches(e, /payments_one_pending_per_order_idx|duplicate key/),
    );

    const pending = await findPendingPaymentByOrderId(db, order.id);
    expect(pending).not.toBeNull();
  });
});

describe('transitionOrderDetailed (state machine + append-only события)', () => {
  it('разрешённый переход пишет событие в той же транзакции и ставит timestamp', async () => {
    const user = await makeUser();
    const { order } = await makeOrderWithPendingPayment({ userId: user.id });

    const res = await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'paid' });
    expect(res.transitioned).toBe(true);
    expect(res.order.status).toBe('paid');
    expect(res.order.paidAt).not.toBeNull();

    const events = await db
      .select()
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.orderId, order.id));
    const transitionEvents = events.filter((e) => e.toStatus === 'paid');
    expect(transitionEvents).toHaveLength(1);
    expect(transitionEvents[0]?.fromStatus).toBe('pending_payment');
  });

  it('повторный переход в тот же статус — идемпотентный noop без нового события', async () => {
    const user = await makeUser();
    const { order } = await makeOrderWithPendingPayment({ userId: user.id });

    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'paid' });
    const res = await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'paid' });
    expect(res.transitioned).toBe(false);

    const events = await db
      .select()
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.orderId, order.id));
    expect(events.filter((e) => e.toStatus === 'paid')).toHaveLength(1);
  });

  it('запрещённый переход бросает OrderTransitionError, статус и события не меняются', async () => {
    const user = await makeUser();
    const order = await createDraftOrder(db, {
      userId: user.id,
      status: 'completed',
      customServiceDescription: 'integration-test order',
    });
    const before = await db
      .select()
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.orderId, order.id));

    await expect(
      transitionOrderDetailed(db, { orderId: order.id, toStatus: 'paid' }),
    ).rejects.toThrow(OrderTransitionError);

    const rows = await db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(firstOf(rows, 'order').status).toBe('completed');
    const after = await db
      .select()
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.orderId, order.id));
    expect(after).toHaveLength(before.length);
  });
});

describe('order_events append-only (DB-триггер)', () => {
  it('UPDATE и DELETE по order_events блокируются триггером', async () => {
    const user = await makeUser();
    const order = await createDraftOrder(db, {
      userId: user.id,
      customServiceDescription: 'integration-test order',
    });

    await expect(
      db.execute(sql`UPDATE order_events SET event_type = 'hacked' WHERE order_id = ${order.id}`),
    ).rejects.toSatisfy((e: unknown) => pgErrorMatches(e, /append-only/));
    await expect(
      db.execute(sql`DELETE FROM order_events WHERE order_id = ${order.id}`),
    ).rejects.toSatisfy((e: unknown) => pgErrorMatches(e, /append-only/));
  });
});

describe('findExpiredPendingOrders (guard оплаченного заказа, C1 defense-in-depth)', () => {
  it('заказ с succeeded-платежом НЕ попадает в expire, без него — попадает', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const user = await makeUser();

    const paidCase = await makeOrderWithPendingPayment({ userId: user.id, expiresAt: past });
    await claimPaymentSucceeded(db, { paymentId: paidCase.payment.id });

    const plainCase = await makeOrderWithPendingPayment({ userId: user.id, expiresAt: past });

    const expired = await findExpiredPendingOrders(db);
    const ids = expired.map((o) => o.id);
    expect(ids).not.toContain(paidCase.order.id);
    expect(ids).toContain(plainCase.order.id);
  });
});

describe('getOrCreateUserByTelegramId (реферальный захват при создании)', () => {
  it('передан referredBy → INSERT ставит referred_by + referred_by_set_at', async () => {
    // Регресс на баг: referred_by_set_at передавался как JS Date в raw-запрос и
    // ронял весь INSERT (кэш не хешил Date) → реферал НЕ фиксировался. Теперь now().
    const referrer = await makeUser();
    const res = await getOrCreateUserByTelegramId(db, {
      telegramId: `tg-cap-${++seq}`,
      referredBy: referrer.id,
    });
    expect(res.created).toBe(true);
    const row = firstOf(
      await db.select().from(schema.users).where(eq(schema.users.id, res.id)),
      'captured user',
    );
    expect(row.referredBy).toBe(referrer.id);
    expect(row.referredBySetAt).toBeInstanceOf(Date);
  });

  it('без referredBy → referred_by и referred_by_set_at остаются null', async () => {
    const res = await getOrCreateUserByTelegramId(db, { telegramId: `tg-nocap-${++seq}` });
    const row = firstOf(
      await db.select().from(schema.users).where(eq(schema.users.id, res.id)),
      'user',
    );
    expect(row.referredBy).toBeNull();
    expect(row.referredBySetAt).toBeNull();
  });
});

describe('consumeLinkToken (merge пользователей)', () => {
  it('полный merge: children, ledger, выплаты, месячная статистика и храповик круга переезжают', async () => {
    const referrer = await makeUser();
    const telegramUser = await makeUser();
    const webSessionId = `ws-${++seq}`;
    const webUser = await makeUser({
      telegramId: null,
      webSessionId,
      referredBy: referrer.id,
      referredBySetAt: new Date(),
    });
    const child = await makeUser({ referredBy: webUser.id });

    // Заказ web-строки + succeeded-платёж + начисление на web-строку.
    const { order, payment } = await makeOrderWithPendingPayment({ userId: child.id });
    await claimPaymentSucceeded(db, { paymentId: payment.id });
    await insertCommissionAccruals(db, {
      sourceUserId: child.id,
      orderId: order.id,
      paymentId: payment.id,
      rows: [{ beneficiaryUserId: webUser.id, level: 1, rateBps: 400, amountUsdCents: 100 }],
    });
    const payout = await createReferralPayout(db, { userId: webUser.id, amountUsdCents: 40 });
    expect(payout.ok).toBe(true);

    // Месячная статистика: май только у web-строки (должен переехать),
    // июнь — у обеих (конфликт PK: остаётся строка telegram-пользователя).
    await db.insert(schema.referralMonthlyStats).values([
      { userId: webUser.id, month: '2026-05-01', consecutiveMetMonths: 3, planMet: true },
      { userId: webUser.id, month: '2026-06-01', consecutiveMetMonths: 4, planMet: true },
      { userId: telegramUser.id, month: '2026-06-01', consecutiveMetMonths: 1, planMet: false },
    ]);
    // Профили партнёра у обеих строк: у web выше круг/ставка — храповик обязан
    // выжить; у web активный буст (позже telegram) — должен переехать.
    await db.insert(schema.referralPartners).values([
      { userId: webUser.id, currentCircle: 2, lockedRateL1Bps: 600, boostUntil: '2027-01-01', boostRateBps: 100 },
      { userId: telegramUser.id, currentCircle: 1, lockedRateL1Bps: 400 },
    ]);

    const { token } = await createLinkToken(db, { webSessionId });
    const res = await consumeLinkToken(db, {
      token,
      telegramId: telegramUser.telegramId ?? '',
    });

    expect(res).toMatchObject({ ok: true, merged: true, userId: telegramUser.id });

    // web-строка удалена; children и денежные сущности перевешаны на telegram-строку.
    const webRows = await db.select().from(schema.users).where(eq(schema.users.id, webUser.id));
    expect(webRows).toHaveLength(0);

    const childRows = await db.select().from(schema.users).where(eq(schema.users.id, child.id));
    expect(firstOf(childRows, 'child').referredBy).toBe(telegramUser.id);

    const tgRows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, telegramUser.id));
    expect(firstOf(tgRows, 'tg user').referredBy).toBe(referrer.id); // наследование реферера

    const accruals = await db
      .select()
      .from(schema.referralAccruals)
      .where(eq(schema.referralAccruals.beneficiaryUserId, telegramUser.id));
    expect(accruals).toHaveLength(1);

    const payouts = await db
      .select()
      .from(schema.referralPayouts)
      .where(eq(schema.referralPayouts.userId, telegramUser.id));
    expect(payouts).toHaveLength(1);

    // I1: месячная история не потеряна cascade-delete'ом.
    const months = await db
      .select()
      .from(schema.referralMonthlyStats)
      .where(eq(schema.referralMonthlyStats.userId, telegramUser.id));
    const byMonth = new Map(months.map((m) => [m.month, m]));
    expect(byMonth.get('2026-05-01')?.consecutiveMetMonths).toBe(3); // переехал
    // Конфликтный месяц: серия слита максимумом (GREATEST(1,4)), plan_met — OR.
    expect(byMonth.get('2026-06-01')?.consecutiveMetMonths).toBe(4);
    expect(byMonth.get('2026-06-01')?.planMet).toBe(true);

    // Храповик: круг и ставка взяты максимумом; активный буст веб-строки переехал.
    const partners = await db
      .select()
      .from(schema.referralPartners)
      .where(eq(schema.referralPartners.userId, telegramUser.id));
    const partner = firstOf(partners, 'partner');
    expect(partner.currentCircle).toBe(2);
    expect(partner.lockedRateL1Bps).toBe(600);
    expect(partner.boostUntil).toBe('2027-01-01');
    expect(partner.boostRateBps).toBe(100);

    // Токен одноразовый.
    const again = await consumeLinkToken(db, {
      token,
      telegramId: telegramUser.telegramId ?? '',
    });
    expect(again).toEqual({ ok: false, reason: 'invalid_or_expired' });
  });
});

describe('referral_accruals ledger (идемпотентность + reversal)', () => {
  it('повторное начисление того же платежа — 0 вставок; reversal-строка проходит частичный unique', async () => {
    const partner = await makeUser();
    const buyer = await makeUser({ referredBy: partner.id, referredBySetAt: new Date() });
    const { order, payment } = await makeOrderWithPendingPayment({ userId: buyer.id });
    await claimPaymentSucceeded(db, { paymentId: payment.id });

    const rows = [
      { beneficiaryUserId: partner.id, level: 1, rateBps: 400, amountUsdCents: 200 },
    ];
    const first = await insertCommissionAccruals(db, {
      sourceUserId: buyer.id,
      orderId: order.id,
      paymentId: payment.id,
      rows,
    });
    const second = await insertCommissionAccruals(db, {
      sourceUserId: buyer.id,
      orderId: order.id,
      paymentId: payment.id,
      rows,
    });
    expect(first).toBe(1);
    expect(second).toBe(0);

    // I2: reversal = НОВАЯ строка status='reversed' с теми же ключами — до
    // частичного индекса такой INSERT падал бы с 23505, ломая контракт ledger'а.
    await db.execute(sql`
      INSERT INTO referral_accruals
        (beneficiary_user_id, source_user_id, order_id, payment_id, level, kind, rate_bps, amount_usd_cents, status)
      VALUES (${partner.id}, ${buyer.id}, ${order.id}, ${payment.id}, 1, 'commission', 400, 200, 'reversed')
    `);

    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(0); // 200 − 200
  });
});

describe('transitionReferralPayout (машина статусов форсится в БД-слое)', () => {
  it('валидная цепочка requested→processing→paid проходит; paid→requested бросает', async () => {
    const partner = await makeUser();
    const buyer = await makeUser({ referredBy: partner.id, referredBySetAt: new Date() });
    const { order, payment } = await makeOrderWithPendingPayment({ userId: buyer.id });
    await claimPaymentSucceeded(db, { paymentId: payment.id });
    await insertCommissionAccruals(db, {
      sourceUserId: buyer.id,
      orderId: order.id,
      paymentId: payment.id,
      rows: [{ beneficiaryUserId: partner.id, level: 1, rateBps: 400, amountUsdCents: 500 }],
    });

    const created = await createReferralPayout(db, { userId: partner.id, amountUsdCents: 300 });
    if (!created.ok) throw new Error('payout не создан');

    const p1 = await transitionReferralPayout(db, {
      payoutId: created.payoutId,
      from: 'requested',
      to: 'processing',
    });
    expect(p1.applied).toBe(true);
    const p2 = await transitionReferralPayout(db, {
      payoutId: created.payoutId,
      from: 'processing',
      to: 'paid',
    });
    expect(p2.applied).toBe(true);

    // I5: «реанимация» выплаченной заявки (= повторный вывод) блокируется до SQL.
    await expect(
      transitionReferralPayout(db, { payoutId: created.payoutId, from: 'paid', to: 'requested' }),
    ).rejects.toThrow(/запрещён машиной статусов/);
  });

  it('перевывод сверх баланса отклоняется с учётом pending-заявок', async () => {
    const partner = await makeUser();
    const buyer = await makeUser({ referredBy: partner.id, referredBySetAt: new Date() });
    const { order, payment } = await makeOrderWithPendingPayment({ userId: buyer.id });
    await claimPaymentSucceeded(db, { paymentId: payment.id });
    await insertCommissionAccruals(db, {
      sourceUserId: buyer.id,
      orderId: order.id,
      paymentId: payment.id,
      rows: [{ beneficiaryUserId: partner.id, level: 1, rateBps: 400, amountUsdCents: 100 }],
    });

    const first = await createReferralPayout(db, { userId: partner.id, amountUsdCents: 80 });
    expect(first.ok).toBe(true);
    const second = await createReferralPayout(db, { userId: partner.id, amountUsdCents: 80 });
    expect(second).toMatchObject({ ok: false, reason: 'insufficient_balance' });
  });
});

describe('createDraftOrder — снапшот надбавки за карту персистится (регрессия PR#51)', () => {
  it('cardIssueFeeKopecks реально пишется в INSERT и читается обратно', async () => {
    const user = await makeUser();
    const order = await createDraftOrder(db, {
      userId: user.id,
      status: 'ready_for_payment',
      customServiceDescription: 'card-fee persist test',
      amountRub: 231000,
      originalAmount: 2000,
      originalCurrency: 'USD',
      commissionPercent: 30,
      cardIssueFeeKopecks: 30800,
    });
    const rows = await db
      .select({ fee: schema.orders.cardIssueFeeKopecks })
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    expect(rows[0]?.fee).toBe(30800);
  });

  it('без cardIssueFeeKopecks колонка = null (обратная совместимость старых заказов)', async () => {
    const user = await makeUser();
    const order = await createDraftOrder(db, {
      userId: user.id,
      status: 'ready_for_payment',
      customServiceDescription: 'no-fee test',
      originalAmount: 2000,
      originalCurrency: 'USD',
    });
    const rows = await db
      .select({ fee: schema.orders.cardIssueFeeKopecks })
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    expect(rows[0]?.fee).toBeNull();
  });
});

describe('idleAgedActiveCards (M5)', () => {
  it('идлит active-карту с last_used_at=NULL по created_at (>90д), свежую не трогает', async () => {
    const user = await makeUser();
    const dayMs = 24 * 60 * 60 * 1000;

    const old = firstOf(
      await db
        .insert(schema.cards)
        .values({
          userId: user.id,
          providerCardId: `pc-old-${++seq}`,
          panMasked: '400000******0001',
          status: 'active',
          createdAt: new Date(Date.now() - 91 * dayMs),
          // lastUsedAt НЕ задаём → NULL, как у реальных выпущенных карт
        })
        .returning(),
      'old card',
    );
    const fresh = firstOf(
      await db
        .insert(schema.cards)
        .values({
          userId: user.id,
          providerCardId: `pc-fresh-${++seq}`,
          panMasked: '400000******0002',
          status: 'active',
          createdAt: new Date(Date.now() - 10 * dayMs),
        })
        .returning(),
      'fresh card',
    );

    const idled = await idleAgedActiveCards(db);
    expect(idled).toBe(1);

    const oldRow = firstOf(
      await db.select().from(schema.cards).where(eq(schema.cards.id, old.id)),
      'old refetch',
    );
    const freshRow = firstOf(
      await db.select().from(schema.cards).where(eq(schema.cards.id, fresh.id)),
      'fresh refetch',
    );
    expect(oldRow.status).toBe('idle'); // раньше NULL last_used_at не матчился — баг M5
    expect(freshRow.status).toBe('active');
  });
});

describe('syncCardBalance (live-баланс кабинета)', () => {
  async function makeCard(balanceUsdCents: number) {
    const user = await makeUser();
    return firstOf(
      await db
        .insert(schema.cards)
        .values({
          userId: user.id,
          providerCardId: `pc-sync-${++seq}`,
          panMasked: '400000******0003',
          status: 'active',
          balanceUsdCents,
          // lastUsedAt НЕ задаём → NULL, как у реальных выпущенных карт
        })
        .returning(),
      'card',
    );
  }

  it('ставит абсолютное значение и НЕ трогает last_used_at (в отличие от updateBalance)', async () => {
    const card = await makeCard(2400);

    // Пассивная синхронизация: баланс — абсолютом, простой карты не сбрасывается.
    expect(await syncCardBalance(db, card.id, 315, 2400)).toBe(true);
    const synced = firstOf(
      await db.select().from(schema.cards).where(eq(schema.cards.id, card.id)),
      'synced refetch',
    );
    expect(synced.balanceUsdCents).toBe(315);
    expect(synced.lastUsedAt).toBeNull(); // иначе просмотр кабинета мешал бы recycle-cron

    // Контраст: updateBalance — дельта + продление last_used_at (наши движения денег).
    await updateBalance(db, card.id, 1000);
    const topped = firstOf(
      await db.select().from(schema.cards).where(eq(schema.cards.id, card.id)),
      'topped refetch',
    );
    expect(topped.balanceUsdCents).toBe(1315);
    expect(topped.lastUsedAt).not.toBeNull();
  });

  it('CAS: устаревший sync после параллельного topup проигрывает гонку и не затирает баланс', async () => {
    const card = await makeCard(2400);

    // Кабинет прочитал 2400 и пошёл в PaySpace; параллельно issue-card сделал topup.
    await updateBalance(db, card.id, 1000); // 2400 → 3400

    // Возврат stale-синка с ожиданием 2400 — должен быть отвергнут.
    expect(await syncCardBalance(db, card.id, 315, 2400)).toBe(false);
    const row = firstOf(
      await db.select().from(schema.cards).where(eq(schema.cards.id, card.id)),
      'refetch',
    );
    expect(row.balanceUsdCents).toBe(3400); // topup сохранён, live-значение не затёрло
  });
});
