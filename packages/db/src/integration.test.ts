import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';

import {
  DEFAULT_REFERRAL_RATE_L1_BPS,
  OrderTransitionError,
  PURCHASED_ORDER_STATUSES,
  analyticsDictionaryRows,
} from '@oplati/types';

import { bootstrapRolesSql } from './bootstrap-roles.ts';
import * as schema from './schema.ts';
import type { DB } from './index.ts';
import {
  claimPaymentSucceeded,
  claimPaymentTerminal,
  findPendingPaymentByOrderId,
  stripOldPaymentPayloads,
  upsertPaymentByProviderRef,
} from './repositories/payments.ts';
import { deleteOldMessages } from './repositories/messages.ts';
import {
  appendOrderEvent,
  claimRenewalReminder,
  createDraftOrder,
  findExpiredPayableOrders,
  setOrderExpiresAt,
  transitionOrderDetailed,
} from './repositories/orders.ts';
import { nextFreekassaNonce } from './repositories/freekassa.ts';
import {
  createConversation,
  getOrCreateActiveConversation,
} from './repositories/conversations.ts';
import { countInvoiceConversion } from './repositories/payments.ts';
import { consumeLinkToken, createLinkToken } from './repositories/link-tokens.ts';
import { setReferrerOnce } from './repositories/referrals.ts';
import { getOrCreateUserByTelegramId } from './repositories/users.ts';
import {
  getReferralBalanceUsdCents,
  insertCommissionAccruals,
  reverseAccrualsForOrder,
  findOrdersWithUnreversedAccruals,
} from './repositories/referral-accruals.ts';
import {
  createReferralPayout,
  transitionReferralPayout,
} from './repositories/referral-cabinet.ts';
import { getMonthlyRollupInput } from './repositories/referral-progression.ts';
import {
  findActiveByUserId,
  findCardByIdForUser,
  findCardsByUserIdForCabinet,
  findCardsToRecycle,
  syncCardBalance,
  updateBalance,
} from './repositories/cards.ts';
import {
  findVpnSubscriptionByUserId,
  upsertVpnSubscription,
} from './repositories/vpn-subscriptions.ts';
import {
  deleteOldAnalyticsEvents,
  insertAnalyticsEvents,
  syncAnalyticsDictionary,
} from './repositories/analytics.ts';

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
/** Сырой клиент — нужен для запросов ПОД РОЛЬЮ (`SET ROLE`), мимо drizzle. */
let pg: PGlite;
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
  // ТОТ ЖЕ DDL, что гоняет `db:init-roles` на боевом контуре (E-9): раньше здесь
  // роли создавались без BYPASSRLS у service_role, и тесты проверяли не тот
  // контур, что едет в прод.
  await client.exec(bootstrapRolesSql());
  const dir = join(import.meta.dirname, '..', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(join(dir, file), 'utf8'));
  }
  pg = client;
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

describe('findExpiredPayableOrders (guard оплаченного заказа C1 + протухшие черновики H-2)', () => {
  it('заказ с succeeded-платежом НЕ попадает в expire, без него — попадает', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const user = await makeUser();

    const paidCase = await makeOrderWithPendingPayment({ userId: user.id, expiresAt: past });
    await claimPaymentSucceeded(db, { paymentId: paidCase.payment.id });

    const plainCase = await makeOrderWithPendingPayment({ userId: user.id, expiresAt: past });

    const expired = await findExpiredPayableOrders(db);
    const ids = expired.map((o) => o.id);
    expect(ids).not.toContain(paidCase.order.id);
    expect(ids).toContain(plainCase.order.id);
  });

  it('черновик ready_for_payment с истёкшей фиксацией цены попадает в выборку, свежий — нет (H-2)', async () => {
    // «Цена зафиксирована до expiresAt» форсится сервером: без этого черновик
    // оставался вечно оплатимым по устаревшему снапшоту курса.
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const user = await makeUser();

    const stale = await createDraftOrder(db, {
      userId: user.id,
      status: 'ready_for_payment',
      customServiceDescription: 'integration-test stale draft',
      amountRub: 50000,
      originalAmount: 500,
      originalCurrency: 'USD',
      expiresAt: past,
    });
    const fresh = await createDraftOrder(db, {
      userId: user.id,
      status: 'ready_for_payment',
      customServiceDescription: 'integration-test fresh draft',
      amountRub: 50000,
      originalAmount: 500,
      originalCurrency: 'USD',
      expiresAt: future,
    });

    const expired = await findExpiredPayableOrders(db);
    const ids = expired.map((o) => o.id);
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(fresh.id);
  });
});

describe('setReferrerOnce — цикл-чек реферального дерева (M-1)', () => {
  it('прямой цикл A↔B: реферал не может стать реферером своего пригласившего', async () => {
    const a = await makeUser();
    const b = await makeUser({ referredBy: a.id });

    const res = await setReferrerOnce(db, a.id, b.id);

    expect(res).toEqual({ set: false, reason: 'cycle' });
    const rows = await db.select().from(schema.users).where(eq(schema.users.id, a.id));
    expect(firstOf(rows, 'user A').referredBy).toBeNull();
  });

  it('транзитивный цикл A→B→C: потомок в цепочке не может стать реферером корня', async () => {
    const a = await makeUser();
    const b = await makeUser({ referredBy: a.id });
    const c = await makeUser({ referredBy: b.id });

    const res = await setReferrerOnce(db, a.id, c.id);

    expect(res).toEqual({ set: false, reason: 'cycle' });
  });

  it('несвязанный реферер ставится нормально (позитивный контроль)', async () => {
    const x = await makeUser();
    const y = await makeUser();

    const res = await setReferrerOnce(db, x.id, y.id);

    expect(res).toEqual({ set: true });
  });
});

describe('setOrderExpiresAt (выравнивание срока заказа по сроку счёта, M-4)', () => {
  it('обновляет expires_at, не трогая статус', async () => {
    const user = await makeUser();
    const { order } = await makeOrderWithPendingPayment({ userId: user.id });
    const target = new Date('2026-07-19T12:00:00.000Z');

    await setOrderExpiresAt(db, order.id, target);

    const rows = await db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    const row = firstOf(rows, 'order');
    expect(row.expiresAt?.toISOString()).toBe(target.toISOString());
    expect(row.status).toBe('pending_payment');
  });
});

describe('payments/create — атомарность INSERT платежа и перехода (M-2)', () => {
  it('сбой транзакции после upsert откатывает INSERT платежа — живого инвойса-сироты не остаётся', async () => {
    const user = await makeUser();
    const order = await createDraftOrder(db, {
      userId: user.id,
      status: 'ready_for_payment',
      customServiceDescription: 'integration-test M-2',
      amountRub: 50000,
      originalAmount: 500,
      originalCurrency: 'USD',
      expiresAt: null,
    });

    await expect(
      db.transaction(async (tx) => {
        const u = await upsertPaymentByProviderRef(tx, {
          orderId: order.id,
          provider: 'loveandpay',
          providerRef: `inv-${++seq}`,
          amountRub: 50000,
        });
        expect(u.isNew).toBe(true);
        throw new Error('transient failure after upsert');
      }),
    ).rejects.toThrow('transient failure after upsert');

    expect(await findPendingPaymentByOrderId(db, order.id)).toBeNull();
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
  it('самореферал гасится при merge компенсирующей строкой', async () => {
    // Аудит 2026-08-10 (HIGH). Человек открыл СВОЮ ЖЕ реф-ссылку в боте:
    // web-строка W стала реферером telegram-строки T, и покупки T начисляли
    // комиссию W. Гейт `referrerId !== userId` это не ловит — строки разные,
    // человек один. После merge такая строка становится (beneficiary=T,
    // source=T), то есть «заработал сам с себя».
    const webSessionId = `ws-self-${++seq}`;
    const webUser = await makeUser({ telegramId: null, webSessionId });
    const telegramUser = await makeUser({ referredBy: webUser.id, referredBySetAt: new Date() });

    const { order, payment } = await makeOrderWithPendingPayment({ userId: telegramUser.id });
    await claimPaymentSucceeded(db, { paymentId: payment.id });
    await insertCommissionAccruals(db, {
      sourceUserId: telegramUser.id,
      orderId: order.id,
      paymentId: payment.id,
      rows: [{ beneficiaryUserId: webUser.id, level: 1, rateBps: 400, amountUsdCents: 100 }],
    });

    const { token } = await createLinkToken(db, { webSessionId });
    const res = await consumeLinkToken(db, {
      token,
      telegramId: telegramUser.telegramId ?? '',
    });
    expect(res).toMatchObject({ ok: true, merged: true });

    const rows = await db
      .select()
      .from(schema.referralAccruals)
      .where(eq(schema.referralAccruals.beneficiaryUserId, telegramUser.id));

    // Ledger append-only: исходная строка остаётся, гашение — НОВАЯ строка.
    expect(rows.filter((r) => r.status === 'accrued')).toHaveLength(1);
    const reversed = rows.filter((r) => r.status === 'reversed');
    expect(reversed).toHaveLength(1);
    expect(reversed[0]?.amountUsdCents).toBe(100);
    // `created_at` копируется из исходной строки: месячные агрегаты кабинета
    // считают «начислено за месяц − реверснуто за месяц» по этой колонке, и
    // гашение старой строки сегодняшним числом рисовало бы партнёру
    // отрицательный доход за текущий месяц (ревью 2026-08-11).
    const original = rows.find((r) => r.status === 'accrued');
    expect(reversed[0]?.createdAt.getTime()).toBe(original?.createdAt.getTime());
  });

  it('уже отменённое начисление (провал заказа) merge НЕ гасит второй раз', async () => {
    // Два писателя reversal с разными ключами дедупа: отмена провалившегося
    // заказа (R-1) ставит created_at = now(), а самореферальное гашение ищет
    // строку с created_at РАВНЫМ исходному. Без общего ключа merge не узнаёт
    // чужую отмену и пишет вторую — баланс партнёра уменьшается дважды за одну
    // и ту же комиссию (находка ревью).
    const webSessionId = `ws-double-${++seq}`;
    const webUser = await makeUser({ telegramId: null, webSessionId });
    const telegramUser = await makeUser({ referredBy: webUser.id, referredBySetAt: new Date() });

    const { order, payment } = await makeOrderWithPendingPayment({ userId: telegramUser.id });
    await claimPaymentSucceeded(db, { paymentId: payment.id });
    await insertCommissionAccruals(db, {
      sourceUserId: telegramUser.id,
      orderId: order.id,
      paymentId: payment.id,
      rows: [{ beneficiaryUserId: webUser.id, level: 1, rateBps: 400, amountUsdCents: 100 }],
    });

    // Заказ провалился ПОСЛЕ оплаты — начисление уже погашено.
    await db.execute(sql`UPDATE orders SET status = 'failed' WHERE id = ${order.id}`);
    expect(await reverseAccrualsForOrder(db, order.id)).toBe(1);

    const { token } = await createLinkToken(db, { webSessionId });
    expect(await consumeLinkToken(db, { token, telegramId: telegramUser.telegramId ?? '' }))
      .toMatchObject({ ok: true, merged: true });

    const rows = await db
      .select()
      .from(schema.referralAccruals)
      .where(eq(schema.referralAccruals.beneficiaryUserId, telegramUser.id));
    expect(rows.filter((r) => r.status === 'reversed')).toHaveLength(1);
    expect(await getReferralBalanceUsdCents(db, telegramUser.id)).toBe(0);
  });

  it('честное начисление merge не гасит', async () => {
    // Контроль на переусердствование: реферер и плательщик — разные люди.
    const webSessionId = `ws-honest-${++seq}`;
    const webUser = await makeUser({ telegramId: null, webSessionId });
    const telegramUser = await makeUser();
    const buyer = await makeUser({ referredBy: webUser.id, referredBySetAt: new Date() });

    const { order, payment } = await makeOrderWithPendingPayment({ userId: buyer.id });
    await claimPaymentSucceeded(db, { paymentId: payment.id });
    await insertCommissionAccruals(db, {
      sourceUserId: buyer.id,
      orderId: order.id,
      paymentId: payment.id,
      rows: [{ beneficiaryUserId: webUser.id, level: 1, rateBps: 400, amountUsdCents: 100 }],
    });

    const { token } = await createLinkToken(db, { webSessionId });
    await consumeLinkToken(db, { token, telegramId: telegramUser.telegramId ?? '' });

    const rows = await db
      .select()
      .from(schema.referralAccruals)
      .where(eq(schema.referralAccruals.beneficiaryUserId, telegramUser.id));
    expect(rows.filter((r) => r.status === 'reversed')).toHaveLength(0);
    expect(rows.filter((r) => r.status === 'accrued')).toHaveLength(1);
  });

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

describe('reverseAccrualsForOrder (отмена начислений провалившегося заказа, R-1)', () => {
  /**
   * Провалившийся заказ реферала с начислением партнёру — исходная точка кейсов.
   * Статус выставляется напрямую: путь до `failed` идёт через фулфилмент, а
   * функции важно лишь состояние, в котором заказ её застаёт.
   */
  async function makeAccruedOrder(amountUsdCents = 200, status: string = 'failed') {
    const partner = await makeUser();
    const buyer = await makeUser({ referredBy: partner.id, referredBySetAt: new Date() });
    const { order, payment } = await makeOrderWithPendingPayment({ userId: buyer.id });
    await claimPaymentSucceeded(db, { paymentId: payment.id });
    await insertCommissionAccruals(db, {
      sourceUserId: buyer.id,
      orderId: order.id,
      paymentId: payment.id,
      rows: [{ beneficiaryUserId: partner.id, level: 1, rateBps: 400, amountUsdCents }],
    });
    await db.execute(sql`UPDATE orders SET status = ${status} WHERE id = ${order.id}`);
    return { partner, buyer, order, payment };
  }

  it('состоявшийся возврат гасится: failed не терминален', async () => {
    // `failed → refund_requested → refunded` — легальный путь ручного возврата.
    // Если inline-отмена не отработала (транзиентный сбой БД), а оператор за
    // это время увёл заказ в возврат, привязка строго к `failed` означала бы,
    // что комиссия остаётся у партнёра по заказу, деньги за который вернули
    // клиенту, — и подобрать её уже нечем (находка ревью).
    const { partner, order } = await makeAccruedOrder(200, 'refunded');

    expect(await reverseAccrualsForOrder(db, order.id)).toBe(1);
    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(0);
  });

  it('оплаченный заказ, закрытый как cancelled после возврата, тоже гасится', async () => {
    // `paid → refund_requested → cancelled` — легальный путь: возврат оформили
    // и закрыли отменой. Деньги у нас не остались, значит комиссии нет. До
    // правки этот статус выпадал из набора, и ни отмена, ни бэкстоп такой заказ
    // не видели — ровно та дыра, которую спека закрывает (находка ревью).
    const { partner, order } = await makeAccruedOrder(200, 'cancelled');

    expect(await reverseAccrualsForOrder(db, order.id)).toBe(1);
    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(0);
  });

  it('гасит КАЖДОЕ начисление заказа, даже если платежей было несколько', async () => {
    // Ключ отмены должен совпадать с ключом начисления `(payment_id,
    // beneficiary, level)`. Иначе у заказа с двумя succeeded-платежами (частичный
    // UNIQUE на payments покрывает только pending, так что это возможно) две
    // строки `accrued` гасились бы одной `reversed`, а `NOT EXISTS` считал бы
    // заказ закрытым — половина комиссии выживала бы молча (находка ревью).
    const partner = await makeUser();
    const buyer = await makeUser({ referredBy: partner.id, referredBySetAt: new Date() });
    const first = await makeOrderWithPendingPayment({ userId: buyer.id });
    await claimPaymentSucceeded(db, { paymentId: first.payment.id });
    await insertCommissionAccruals(db, {
      sourceUserId: buyer.id,
      orderId: first.order.id,
      paymentId: first.payment.id,
      rows: [{ beneficiaryUserId: partner.id, level: 1, rateBps: 400, amountUsdCents: 100 }],
    });
    // Второй платёж того же заказа (доплата) — своё начисление.
    const { payment: second } = await upsertPaymentByProviderRef(db, {
      orderId: first.order.id,
      provider: 'loveandpay',
      providerRef: `inv-second-${Date.now()}`,
      amountRub: 50000,
    });
    await claimPaymentSucceeded(db, { paymentId: second.id });
    await insertCommissionAccruals(db, {
      sourceUserId: buyer.id,
      orderId: first.order.id,
      paymentId: second.id,
      rows: [{ beneficiaryUserId: partner.id, level: 1, rateBps: 400, amountUsdCents: 100 }],
    });
    await db.execute(sql`UPDATE orders SET status = 'failed' WHERE id = ${first.order.id}`);
    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(200);

    expect(await reverseAccrualsForOrder(db, first.order.id)).toBe(2);
    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(0);
    expect(await findOrdersWithUnreversedAccruals(db, 50)).not.toContain(first.order.id);
  });

  it('ЗАПРОШЕННЫЙ возврат не гасится: его ещё могут отклонить', async () => {
    // `refund_requested → completed` разрешён (возврат отклонили, заказ
    // исполнен). Гашение необратимо — досчитать начисление заново нечем, —
    // поэтому ждём разрешения: деньги клиенту ещё не вернули (находка ревью).
    const { partner, order } = await makeAccruedOrder(200, 'refund_requested');

    expect(await reverseAccrualsForOrder(db, order.id)).toBe(0);
    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(200);
  });

  it('бэкстоп видит и возвратные статусы, а не только failed', async () => {
    const { order } = await makeAccruedOrder(200, 'refunded');

    expect(await findOrdersWithUnreversedAccruals(db, 50)).toContain(order.id);
  });

  it('заказ НЕ в failed не гасится: отмена привязана к статусу, а не к месту вызова', async () => {
    // markOrderFailed глотает запрещённый переход (например, заказ уже
    // completed) и всё равно доходит до отмены — без этой проверки партнёр терял
    // бы комиссию за ИСПОЛНЕННЫЙ заказ, а вернуть её нечем: recovery считает
    // пропуском только заказ без строк ledger'а (находка ревью).
    const { partner, order } = await makeAccruedOrder(200, 'completed');

    expect(await reverseAccrualsForOrder(db, order.id)).toBe(0);
    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(200);
  });

  it('гасит начисления заказа: баланс партнёра возвращается к нулю', async () => {
    const { partner, order } = await makeAccruedOrder();
    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(200);

    expect(await reverseAccrualsForOrder(db, order.id)).toBe(1);
    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(0);
  });

  it('идемпотентен: повторный вызов не создаёт вторую компенсирующую строку', async () => {
    const { partner, order } = await makeAccruedOrder();
    await reverseAccrualsForOrder(db, order.id);

    // Без этого баланс ушёл бы в минус на каждом ретрае крона/повторе webhook.
    expect(await reverseAccrualsForOrder(db, order.id)).toBe(0);
    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(0);

    const rows = await db.execute<{ status: string }>(sql`
      SELECT status FROM referral_accruals WHERE order_id = ${order.id} AND status = 'reversed'
    `);
    expect(rows).toHaveLength(1);
  });

  it('заказ без начислений отрабатывает без ошибки и без строк', async () => {
    const buyer = await makeUser();
    const { order } = await makeOrderWithPendingPayment({ userId: buyer.id });

    expect(await reverseAccrualsForOrder(db, order.id)).toBe(0);
  });

  it('append-only: исходная строка остаётся accrued, а created_at отмены — момент отмены', async () => {
    const { order } = await makeAccruedOrder();
    // Отодвигаем начисление в прошлый месяц: иначе копия created_at и «сейчас»
    // неотличимы (обе строки создаются в один момент), и тест пропустил бы
    // регресс на поведение consumeLinkToken, где created_at копируется.
    await db.execute(sql`
      UPDATE referral_accruals SET created_at = now() - interval '40 days'
      WHERE order_id = ${order.id} AND status = 'accrued'
    `);
    const before = await db.execute<{ created_at: Date }>(sql`
      SELECT created_at FROM referral_accruals WHERE order_id = ${order.id} AND status = 'accrued'
    `);
    const accruedAt = firstOf(before, 'исходное начисление').created_at;

    await reverseAccrualsForOrder(db, order.id);

    const rows = await db.execute<{ status: string; created_at: Date; amount_usd_cents: number }>(sql`
      SELECT status, created_at, amount_usd_cents FROM referral_accruals
      WHERE order_id = ${order.id} ORDER BY status
    `);
    expect(rows.map((r) => r.status)).toEqual(['accrued', 'reversed']);
    // Суммы совпадают — отмена гасит ровно то, что начислено.
    expect(rows[0]?.amount_usd_cents).toBe(rows[1]?.amount_usd_cents);
    // created_at отмены — НЕ копия исходного (иначе отмена попадёт в месячный
    // агрегат прошлого месяца и задним числом изменит показанную цифру).
    // Строго больше: `>=` проходил бы и для точной копии, то есть регресс на
    // поведение `consumeLinkToken` тест бы не поймал (находка ревью).
    const reversedAt = firstOf(rows.filter((r) => r.status === 'reversed'), 'отмена').created_at;
    expect(new Date(reversedAt).getTime()).toBeGreaterThan(new Date(accruedAt).getTime());
  });

  it('гонка двух вызовов: вторая отмена не проходит даже в обход NOT EXISTS', async () => {
    // NOT EXISTS сам по себе не защищает: в READ COMMITTED два параллельных
    // вызова (inline-путь issue-card и бэкстоп-крон) видят снапшот без чужой
    // незакоммиченной строки и вставляют обе — баланс уходит в минус. Гарантию
    // даёт частичный UNIQUE на reversed; здесь проверяем именно его, вставляя
    // дубль напрямую, минуя проверку функции.
    const { partner, buyer, order, payment } = await makeAccruedOrder();
    await reverseAccrualsForOrder(db, order.id);

    await expect(
      db.execute(sql`
        INSERT INTO referral_accruals
          (beneficiary_user_id, source_user_id, order_id, payment_id, level, kind,
           rate_bps, amount_usd_cents, status)
        VALUES (${partner.id}, ${buyer.id}, ${order.id}, ${payment.id}, 1, 'commission', 400, 200, 'reversed')
      `),
    ).rejects.toSatisfy((err: unknown) => pgErrorMatches(err, /duplicate key|unique/i));

    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(0);
  });

  it('гасит все строки заказа, не задевая начисления других заказов', async () => {
    const { partner, buyer, order } = await makeAccruedOrder();
    // Второй заказ того же покупателя — он остаётся живым.
    const second = await makeOrderWithPendingPayment({ userId: buyer.id });
    await claimPaymentSucceeded(db, { paymentId: second.payment.id });
    await insertCommissionAccruals(db, {
      sourceUserId: buyer.id,
      orderId: second.order.id,
      paymentId: second.payment.id,
      rows: [{ beneficiaryUserId: partner.id, level: 1, rateBps: 400, amountUsdCents: 300 }],
    });
    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(500);

    await reverseAccrualsForOrder(db, order.id);

    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(300);
  });
});

describe('«покупка состоялась» — один список статусов (R-6)', () => {
  it('оборот сети считает ровно PURCHASED_ORDER_STATUSES и игнорирует остальные', async () => {
    // Список был объявлен независимо в прогрессии, витрине и выборке recovery.
    // Новый статус развёл бы их молча: партнёр видел бы одну сеть, ставку
    // получал бы по другой. Тест ходит через реальную выборку оборота.
    const partner = await makeUser();
    const monthKey = new Date().toISOString().slice(0, 8) + '01';

    for (const status of PURCHASED_ORDER_STATUSES) {
      const buyer = await makeUser({ referredBy: partner.id, referredBySetAt: new Date() });
      const { order } = await makeOrderWithPendingPayment({ userId: buyer.id });
      await db.execute(
        sql`UPDATE orders SET status = ${status}, paid_at = now() WHERE id = ${order.id}`,
      );
    }
    // Контроль: провалившийся заказ в оборот не идёт.
    const failedBuyer = await makeUser({ referredBy: partner.id, referredBySetAt: new Date() });
    const failed = await makeOrderWithPendingPayment({ userId: failedBuyer.id });
    await db.execute(
      sql`UPDATE orders SET status = 'failed', paid_at = now() WHERE id = ${failed.order.id}`,
    );

    const input = await getMonthlyRollupInput(db, partner.id, monthKey);

    // makeOrderWithPendingPayment создаёт заказ на 500 USD-центов.
    expect(input.networkTurnoverUsdCents).toBe(PURCHASED_ORDER_STATUSES.length * 500);
  });
});

describe('дефолтная ставка партнёра — один источник (R-2)', () => {
  it('дефолт колонки locked_rate_l1_bps совпадает с базовой ставкой таблицы', async () => {
    // Ставка применяется из ДВУХ мест: колонка БД (когда профиль создаёт крон
    // прогрессии) и константа кода (когда профиля ещё нет — начисление считает
    // по ней). Числа совпадают по случайности; разъедутся — партнёру начислят
    // не то, что показано в кабинете, и без ошибки. Тест читает фактический
    // дефолт из ПРИМЕНЁННЫХ миграций, а не из schema.ts.
    const rows = await db.execute<{ column_default: string | null }>(sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'referral_partners' AND column_name = 'locked_rate_l1_bps'
    `);
    const raw = firstOf(rows, 'дефолт колонки').column_default ?? '';
    const dbDefault = Number.parseInt(raw, 10);

    expect(dbDefault).toBe(DEFAULT_REFERRAL_RATE_L1_BPS);
  });
});

describe('findOrdersWithUnreversedAccruals (бэкстоп сверки ledger, R-1.7)', () => {
  async function makeAccruedOrder(status: 'paid' | 'failed' | 'completed') {
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
    // Статус выставляем напрямую: путь до failed идёт через фулфилмент, а тесту
    // важно лишь состояние, в котором заказ застаёт крон.
    await db.execute(sql`UPDATE orders SET status = ${status} WHERE id = ${order.id}`);
    return { partner, order };
  }

  it('находит failed-заказ с непогашенным начислением', async () => {
    const { order } = await makeAccruedOrder('failed');

    const found = await findOrdersWithUnreversedAccruals(db, 50);

    expect(found).toContain(order.id);
  });

  it('после отмены заказ из выборки уходит — крон не крутит его вечно', async () => {
    const { order } = await makeAccruedOrder('failed');
    await reverseAccrualsForOrder(db, order.id);

    expect(await findOrdersWithUnreversedAccruals(db, 50)).not.toContain(order.id);
  });

  it('живые заказы не трогает: paid и completed остаются с начислениями', async () => {
    const paid = await makeAccruedOrder('paid');
    const completed = await makeAccruedOrder('completed');

    const found = await findOrdersWithUnreversedAccruals(db, 50);

    expect(found).not.toContain(paid.order.id);
    expect(found).not.toContain(completed.order.id);
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

describe('срок жизни карты 180 дней (S-9)', () => {
  const dayMs = 24 * 60 * 60 * 1000;

  async function makeCard(opts: {
    userId: string;
    status: 'active' | 'idle' | 'recycled';
    ageDays: number;
    lastUsedAgeDays?: number;
    recycledAt?: Date;
  }) {
    return firstOf(
      await db
        .insert(schema.cards)
        .values({
          userId: opts.userId,
          providerCardId: `pc-life-${++seq}`,
          panMasked: '400000******0009',
          status: opts.status,
          createdAt: new Date(Date.now() - opts.ageDays * dayMs),
          ...(opts.lastUsedAgeDays !== undefined
            ? { lastUsedAt: new Date(Date.now() - opts.lastUsedAgeDays * dayMs) }
            : {}),
          ...(opts.recycledAt ? { recycledAt: opts.recycledAt } : {}),
        })
        .returning(),
      'card',
    );
  }

  it('РЕГРЕСС: закрывает ACTIVE-карту старше 180д — регулярно доливаемая не идлилась и не закрывалась НИКОГДА', async () => {
    const user = await makeUser();
    // Клиент доливал карту неделю назад → last_used_at свежий → idle-порог (90д)
    // не сработает никогда, а раньше release требовал status='idle'.
    const card = await makeCard({
      userId: user.id,
      status: 'active',
      ageDays: 200,
      lastUsedAgeDays: 7,
    });

    const toRecycle = await findCardsToRecycle(db);
    expect(toRecycle.map((c) => c.id)).toContain(card.id);
  });

  it('закрывает idle-карту старше 180д и НЕ трогает моложе 180д', async () => {
    const user = await makeUser();
    const old = await makeCard({ userId: user.id, status: 'idle', ageDays: 181 });
    const young = await makeCard({ userId: user.id, status: 'idle', ageDays: 179 });

    const ids = (await findCardsToRecycle(db)).map((c) => c.id);
    expect(ids).toContain(old.id);
    expect(ids).not.toContain(young.id);
  });

  it('уже закрытую карту не берёт повторно (recycled_at IS NULL)', async () => {
    const user = await makeUser();
    const done = await makeCard({
      userId: user.id,
      status: 'recycled',
      ageDays: 300,
      recycledAt: new Date(),
    });

    const ids = (await findCardsToRecycle(db)).map((c) => c.id);
    expect(ids).not.toContain(done.id);
  });

  it('кабинет скрывает просроченную карту, даже пока cron до неё не дошёл', async () => {
    const user = await makeUser();
    const expired = await makeCard({ userId: user.id, status: 'active', ageDays: 181 });
    const alive = await makeCard({ userId: user.id, status: 'active', ageDays: 30 });

    const ids = (await findCardsByUserIdForCabinet(db, user.id)).map((c) => c.id);
    expect(ids).toContain(alive.id);
    expect(ids).not.toContain(expired.id);
  });

  it('реквизиты просроченной карты не отдаются по card-details', async () => {
    const user = await makeUser();
    const expired = await makeCard({ userId: user.id, status: 'idle', ageDays: 181 });
    const alive = await makeCard({ userId: user.id, status: 'active', ageDays: 30 });

    expect(await findCardByIdForUser(db, expired.id, user.id)).toBeNull();
    expect(await findCardByIdForUser(db, alive.id, user.id)).not.toBeNull();
  });

  it('РЕГРЕСС (HIGH): просроченную карту findActiveByUserId больше не отдаёт под долив', async () => {
    const user = await makeUser();
    // До фикса эта выборка была единственной без возрастного условия: карта
    // любого возраста доливалась деньгами клиента, а recycle-cards закрывал её
    // и возвращал остаток на наш VCC.
    await makeCard({ userId: user.id, status: 'active', ageDays: 200 });

    expect(await findActiveByUserId(db, user.id)).toBeNull();
  });

  it('граница реюза совпадает с витринной: 179.5 дня видят и кабинет, и заказ', async () => {
    const user = await makeUser();
    const dying = await makeCard({ userId: user.id, status: 'active', ageDays: 179.5 });

    // Разъезд этих двух выборок означал бы «кабинет показывает карту рабочей,
    // а заказ берёт $4 за выпуск новой». Запас перед доливом — в issue-card.
    expect((await findActiveByUserId(db, user.id))?.id).toBe(dying.id);
    expect((await findCardsByUserIdForCabinet(db, user.id)).map((c) => c.id)).toContain(dying.id);
  });

  it('свежую активную карту findActiveByUserId по-прежнему отдаёт (самую новую)', async () => {
    const user = await makeUser();
    await makeCard({ userId: user.id, status: 'active', ageDays: 100 });
    const newest = await makeCard({ userId: user.id, status: 'active', ageDays: 2 });

    expect((await findActiveByUserId(db, user.id))?.id).toBe(newest.id);
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

describe('retention (M-13): deleteOldMessages / stripOldPaymentPayloads', () => {
  const OLD = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);

  it('удаляет только сообщения старше порога, уважая батч-лимит', async () => {
    const user = await makeUser();
    const conv = firstOf(
      await db
        .insert(schema.conversations)
        .values({ userId: user.id, channel: 'telegram' })
        .returning(),
      'conversations insert',
    );
    for (let i = 0; i < 3; i++) {
      await db.insert(schema.messages).values({
        conversationId: conv.id,
        role: 'user',
        content: `old-${i}`,
        createdAt: OLD,
      });
    }
    await db
      .insert(schema.messages)
      .values({ conversationId: conv.id, role: 'user', content: 'fresh' });

    // Батч меньше бэклога → удаляет ровно limit, остальное — следующим проходом.
    expect(await deleteOldMessages(db, { olderThanDays: 90, limit: 2 })).toBe(2);
    expect(await deleteOldMessages(db, { olderThanDays: 90, limit: 10 })).toBe(1);
    // Свежее сообщение не тронуто; чистить больше нечего.
    expect(await deleteOldMessages(db, { olderThanDays: 90, limit: 10 })).toBe(0);
    const left = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conv.id));
    expect(left.map((m) => m.content)).toEqual(['fresh']);
  });

  it('raw_payload чистится только у старых платежей; сама строка платежа остаётся', async () => {
    const user = await makeUser();
    const { payment } = await makeOrderWithPendingPayment({ userId: user.id });
    await db
      .update(schema.payments)
      .set({ createdAt: OLD, rawPayload: { invoice: { id: 'inv-old' } } })
      .where(eq(schema.payments.id, payment.id));
    const { payment: freshPayment } = await makeOrderWithPendingPayment({ userId: user.id });
    await db
      .update(schema.payments)
      .set({ rawPayload: { invoice: { id: 'inv-fresh' } } })
      .where(eq(schema.payments.id, freshPayment.id));

    expect(await stripOldPaymentPayloads(db, { olderThanDays: 180, limit: 10 })).toBe(1);
    expect(await stripOldPaymentPayloads(db, { olderThanDays: 180, limit: 10 })).toBe(0);

    const oldRow = firstOf(
      await db.select().from(schema.payments).where(eq(schema.payments.id, payment.id)),
      'old payment',
    );
    expect(oldRow.rawPayload).toBeNull();
    expect(oldRow.amountRub).toBe(50000); // строка платежа цела
    const freshRow = firstOf(
      await db.select().from(schema.payments).where(eq(schema.payments.id, freshPayment.id)),
      'fresh payment',
    );
    expect(freshRow.rawPayload).not.toBeNull();
  });
});

describe('upsertVpnSubscription (снимок VPN-ссылки Remnawave, один на пользователя)', () => {
  it('создаёт строку, а на конфликте user_id обновляет ссылку на месте (created_at цел)', async () => {
    const user = await makeUser();
    const expireAt = new Date('2026-08-21T00:00:00.000Z');
    const base = {
      userId: user.id,
      telegramId: String(user.telegramId),
      remnawaveUuid: 'dd971f3c-9332-4821-9337-9ca95682758c',
      status: 'ACTIVE',
      expireAt,
    };

    const first = await upsertVpnSubscription(db, {
      ...base,
      shortUuid: 'AAAA1111',
      subscriptionUrl: 'https://sub.test/api/sub/AAAA1111',
    });

    // «Обновить ссылку»: revoke в панели выдал новый shortUuid — upsert
    // перезаписывает снимок, не плодя вторую строку.
    const second = await upsertVpnSubscription(db, {
      ...base,
      shortUuid: 'BBBB2222',
      subscriptionUrl: 'https://sub.test/api/sub/BBBB2222',
    });

    expect(second.id).toBe(first.id);
    expect(second.shortUuid).toBe('BBBB2222');
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());

    const found = await findVpnSubscriptionByUserId(db, user.id);
    expect(found?.subscriptionUrl).toBe('https://sub.test/api/sub/BBBB2222');
    expect(found?.expireAt.getTime()).toBe(expireAt.getTime());

    const rows = await db
      .select()
      .from(schema.vpnSubscriptions)
      .where(eq(schema.vpnSubscriptions.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it('у пользователя без подписки find возвращает null', async () => {
    const user = await makeUser();
    expect(await findVpnSubscriptionByUserId(db, user.id)).toBeNull();
  });
});

describe('nextFreekassaNonce (последовательность Postgres, миграция 0026)', () => {
  it('монотонно возрастает при ПАРАЛЛЕЛЬНЫХ вызовах', async () => {
    // Ровно то, чего не даёт Date.now(): два конкурентных confirm_order в одну
    // миллисекунду получили бы одинаковый nonce, и провайдер отверг бы второй
    // запрос («должен всегда быть больше предыдущего»).
    const values = await Promise.all(
      Array.from({ length: 25 }, () => nextFreekassaNonce(db)),
    );

    expect(new Set(values).size).toBe(values.length);
    const sorted = [...values].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBeGreaterThan(sorted[i - 1] as number);
    }
  });

  it('стартует выше unix-времени в секундах — не конфликтует с прежними nonce = time()', async () => {
    // Если по магазину уже слались запросы с nonce = time(), счётчик с единицы
    // был бы МЕНЬШЕ использованного и провайдер отвергал бы всё подряд.
    const value = await nextFreekassaNonce(db);
    expect(value).toBeGreaterThan(2_000_000_000);
    expect(Number.isSafeInteger(value)).toBe(true);
  });
});

describe('countInvoiceConversion (метрика «счёт выставлен → оплачен»)', () => {
  const WINDOW = { windowMinutes: 70, graceMinutes: 10 };

  /**
   * События вставляем НАПРЯМУЮ с явным `created_at`: окно метрики сдвинуто в
   * прошлое, а `order_events` append-only (триггер 0018 запрещает UPDATE) —
   * задним числом подвинуть время у обычного перехода нельзя.
   */
  async function addEvent(orderId: string, eventType: string, minutesAgo: number) {
    await db.execute(sql`
      INSERT INTO order_events (order_id, actor_type, event_type, created_at)
      VALUES (${orderId}, 'system', ${eventType}, now() - make_interval(mins => ${minutesAgo}::int))
    `);
  }

  async function makeOrder(userId: string) {
    return await createDraftOrder(db, {
      userId,
      status: 'pending_payment',
      customServiceDescription: 'conversion-test order',
      amountRub: 50000,
      originalAmount: 500,
      originalCurrency: 'USD',
    });
  }

  /**
   * База PGlite общая на весь сьют, поэтому меряем ДЕЛЬТУ, а не абсолютные
   * числа: иначе тесты зависели бы от порядка исполнения соседей.
   */
  async function delta(fn: () => Promise<void>) {
    const before = await countInvoiceConversion(db, WINDOW);
    await fn();
    const after = await countInvoiceConversion(db, WINDOW);
    return { invoiced: after.invoiced - before.invoiced, paid: after.paid - before.paid };
  }

  it('считает выставленные и оплаченные в окне', async () => {
    const user = await makeUser();

    const res = await delta(async () => {
      const paidOrder = await makeOrder(user.id);
      const unpaidOrder = await makeOrder(user.id);
      await addEvent(paidOrder.id, 'payment_invoice_created', 30);
      await addEvent(paidOrder.id, 'payment_succeeded', 25);
      await addEvent(unpaidOrder.id, 'payment_invoice_created', 30);
    });

    expect(res).toEqual({ invoiced: 2, paid: 1 });
  });

  it('один заказ считается ОДИН раз, даже если счёт выставлялся повторно', async () => {
    // Повторный confirm пишет второе `payment_invoice_created` (duplicate:true) —
    // без DISTINCT заказ удваивал бы знаменатель и занижал конверсию.
    const user = await makeUser();

    const res = await delta(async () => {
      const order = await makeOrder(user.id);
      await addEvent(order.id, 'payment_invoice_created', 30);
      await addEvent(order.id, 'payment_invoice_created', 29);
    });

    expect(res.invoiced).toBe(1);
  });

  it('свежие счета исключены отсрочкой, старые — окном', async () => {
    const user = await makeUser();

    const res = await delta(async () => {
      const tooFresh = await makeOrder(user.id);
      const tooOld = await makeOrder(user.id);
      await addEvent(tooFresh.id, 'payment_invoice_created', 2);
      await addEvent(tooOld.id, 'payment_invoice_created', 500);
    });

    expect(res.invoiced).toBe(0);
  });

  it('оплата ПОЗЖЕ окна всё равно засчитывается заказу', async () => {
    // Считаем судьбу счёта, а не события в окне: иначе оплата на 71-й минуте
    // выглядела бы как неоплаченный счёт и давала ложный алёрт.
    const user = await makeUser();

    const res = await delta(async () => {
      const order = await makeOrder(user.id);
      await addEvent(order.id, 'payment_invoice_created', 60);
      await addEvent(order.id, 'payment_succeeded', 1);
    });

    expect(res).toEqual({ invoiced: 1, paid: 1 });
  });
});

describe('claimRenewalReminder (атомарный дедуп напоминаний, B-2)', () => {
  async function makeCompletedOrder(userId: string) {
    return await createDraftOrder(db, {
      userId,
      status: 'completed',
      customServiceDescription: 'renewal-test order',
      amountRub: 50000,
      originalAmount: 500,
      originalCurrency: 'USD',
    });
  }

  it('первый claim выигрывает, второй молча проигрывает', async () => {
    const user = await makeUser();
    const order = await makeCompletedOrder(user.id);

    expect(await claimRenewalReminder(db, order.id)).toBe(true);
    expect(await claimRenewalReminder(db, order.id)).toBe(false);
  });

  it('ПАРАЛЛЕЛЬНЫЕ прогоны джоба: ровно один claim и ровно одно событие', async () => {
    // Прежняя схема «выбрать через NOT EXISTS → отправить → записать» атомарной
    // не была, и клиент получал напоминание дважды.
    const user = await makeUser();
    const order = await makeCompletedOrder(user.id);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimRenewalReminder(db, order.id)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);

    const events = await db
      .select()
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.orderId, order.id));
    expect(events.filter((e) => e.eventType === 'renewal_reminder_sent')).toHaveLength(1);
  });

  it('уникальность частичная: другие типы событий по тому же заказу не мешают', async () => {
    const user = await makeUser();
    const order = await makeCompletedOrder(user.id);

    await appendOrderEvent(db, { orderId: order.id, eventType: 'note', actorType: 'system' });
    await appendOrderEvent(db, { orderId: order.id, eventType: 'note', actorType: 'system' });
    expect(await claimRenewalReminder(db, order.id)).toBe(true);
  });

  it('заказы независимы: claim по одному не блокирует другой', async () => {
    const user = await makeUser();
    const a = await makeCompletedOrder(user.id);
    const b = await makeCompletedOrder(user.id);

    expect(await claimRenewalReminder(db, a.id)).toBe(true);
    expect(await claimRenewalReminder(db, b.id)).toBe(true);
  });
});

describe('getOrCreateActiveConversation (гонка первого сообщения)', () => {
  it('ПАРАЛЛЕЛЬНЫЕ вызовы дают ОДИН диалог — история не расщепляется', async () => {
    const user = await makeUser();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        getOrCreateActiveConversation(db, { userId: user.id, channel: 'telegram' }),
      ),
    );

    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('каналы независимы: telegram и web — разные диалоги', async () => {
    const user = await makeUser();
    const tg = await getOrCreateActiveConversation(db, { userId: user.id, channel: 'telegram' });
    const web = await getOrCreateActiveConversation(db, { userId: user.id, channel: 'web' });
    expect(tg.id).not.toBe(web.id);
  });

  it('«Очистить диалог» по-прежнему создаёт НОВЫЙ диалог — уникального индекса тут быть не должно', async () => {
    const user = await makeUser();
    const first = await getOrCreateActiveConversation(db, { userId: user.id, channel: 'web' });
    const fresh = await createConversation(db, { userId: user.id, channel: 'web' });
    expect(fresh.id).not.toBe(first.id);

    // Порядок задаём ЯВНО: у PGlite часы миллисекундные (проверено — шесть
    // вставок подряд дают два уникальных `now()`), поэтому без этого тест
    // плавал бы. В самом запросе теперь есть тай-брейкер по id, но полагаться
    // в тесте на случайный порядок uuid — не проверка, а совпадение.
    await db.execute(sql`
      UPDATE conversations SET created_at = now() + interval '1 second' WHERE id = ${fresh.id}
    `);

    // Дальше подхватывается самый свежий.
    const resumed = await getOrCreateActiveConversation(db, { userId: user.id, channel: 'web' });
    expect(resumed.id).toBe(fresh.id);
    expect(resumed.created).toBe(false);

    // И ровно два диалога: геттер не создал третьего.
    const rows = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.userId, user.id));
    expect(rows).toHaveLength(2);
  });
});

// ─── Поведенческая аналитика ──────────────────────────────────────────────

describe('analytics_events', () => {
  it('идемпотентность по event_key: повтор батча не удваивает воронку', async () => {
    const key = `ev-${++seq}-${Date.now()}`;
    const base = {
      eventKey: key,
      name: 'catalog_open',
      channel: 'web',
      origin: 'client' as const,
      webSessionId: `sess-${seq}`,
      occurredAt: new Date(),
    };

    expect(await insertAnalyticsEvents(db, [base])).toBe(1);
    // Ретрай sendBeacon / двойной клик.
    expect(await insertAnalyticsEvents(db, [base])).toBe(0);

    const rows = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM analytics_events WHERE event_key = ${key}`,
    );
    expect(Number(firstOf(rows, 'count').count)).toBe(1);
  });

  it('история неизменяема: UPDATE отклоняется триггером', async () => {
    const key = `ev-immutable-${++seq}`;
    await insertAnalyticsEvents(db, [
      {
        eventKey: key,
        name: 'page_view',
        channel: 'web',
        origin: 'client',
        webSessionId: `sess-${seq}`,
        occurredAt: new Date(),
      },
    ]);

    // Именно поэтому резолв личности — JOIN, а не backfill: переписать
    // накопленное невозможно даже намеренно.
    await expect(
      db.execute(sql`UPDATE analytics_events SET name = 'hacked' WHERE event_key = ${key}`),
    ).rejects.toSatisfy((err: unknown) => pgErrorMatches(err, /append-only/));
  });

  it('retention удаляет старое батчами, свежее не трогает', async () => {
    const tag = `ret-${++seq}`;
    const old = new Date(Date.now() - 500 * 24 * 60 * 60 * 1000);
    await insertAnalyticsEvents(db, [
      { eventKey: `${tag}-old-1`, name: 'page_view', channel: 'web', origin: 'client', occurredAt: old },
      { eventKey: `${tag}-old-2`, name: 'page_view', channel: 'web', origin: 'client', occurredAt: old },
      { eventKey: `${tag}-new`, name: 'page_view', channel: 'web', origin: 'client', occurredAt: new Date() },
    ]);

    // DELETE разрешён (в отличие от order_events) — иначе телеметрия росла бы вечно.
    const deleted = await deleteOldAnalyticsEvents(db, { olderThanDays: 400, limit: 100 });
    expect(deleted).toBeGreaterThanOrEqual(2);

    const left = await db.execute<{ event_key: string }>(
      sql`SELECT event_key FROM analytics_events WHERE event_key LIKE ${`${tag}%`}`,
    );
    expect(left.map((r) => r.event_key)).toEqual([`${tag}-new`]);
  });

  it('словарь синхронизируется идемпотентно и переписывает подписи', async () => {
    const rows = analyticsDictionaryRows();
    await syncAnalyticsDictionary(db, rows);
    await syncAnalyticsDictionary(db, rows);

    const stored = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM analytics_event_types`,
    );
    expect(Number(firstOf(stored, 'dict count').count)).toBe(rows.length);

    // Правка подписи в коде доезжает до отчёта без миграции.
    await syncAnalyticsDictionary(db, [
      { ...firstOf(rows, 'first row'), title: 'Новая подпись' },
    ]);
    const title = await db.execute<{ title: string }>(
      sql`SELECT title FROM analytics_event_types WHERE name = ${firstOf(rows, 'first row').name}`,
    );
    expect(firstOf(title, 'title').title).toBe('Новая подпись');
  });
});

describe('analytics_timeline / analytics_user_path', () => {
  it('анонимные события подписываются именем после привязки Telegram — без единого UPDATE', async () => {
    const webSessionId = `sess-link-${++seq}`;
    const telegramId = `tg-link-${seq}`;

    // 1. Аноним ходит по сайту: user_id ещё не существует.
    await insertAnalyticsEvents(db, [
      {
        eventKey: `${webSessionId}-1`,
        name: 'page_view',
        channel: 'web',
        origin: 'client',
        webSessionId,
        occurredAt: new Date(Date.now() - 60_000),
      },
      {
        eventKey: `${webSessionId}-2`,
        name: 'catalog_open',
        channel: 'web',
        origin: 'client',
        webSessionId,
        occurredAt: new Date(Date.now() - 30_000),
      },
    ]);

    const before = await db.execute<{ user_id: string | null }>(
      sql`SELECT user_id FROM analytics_timeline WHERE web_session_hash = left(md5(${webSessionId}), 12)`,
    );
    expect(before).toHaveLength(2);
    expect(before.every((r) => r.user_id === null)).toBe(true);

    // 2. Клиент привязывает Telegram — тот самый момент опознания.
    const token = await createLinkToken(db, { webSessionId });
    const consumed = await consumeLinkToken(db, {
      token: token.token,
      telegramId,
      displayName: 'Тест',
    });
    expect(consumed.ok).toBe(true);

    // 3. Прошлые события подписаны задним числом: это JOIN, а не backfill.
    const after = await db.execute<{ user_id: string | null; telegram_id: string | null; name: string }>(
      sql`SELECT user_id, telegram_id, name FROM analytics_timeline WHERE web_session_hash = left(md5(${webSessionId}), 12)`,
    );
    // Два наших события + веха telegram_linked из link_tokens: сам факт
    // привязки телеметрией не дублируется, он читается из БД.
    expect(after).toHaveLength(3);
    expect(after.map((r) => r.name)).toContain('telegram_linked');
    expect(after.every((r) => r.user_id !== null)).toBe(true);
    expect(after.every((r) => r.telegram_id === telegramId)).toBe(true);
  });

  it('merge пользователей не трогает аналитику и не теряет её', async () => {
    // Клиент уже платил в боте (telegram-строка есть), потом пришёл на сайт
    // анонимно — merge убивает ВЕБ-строку. Если бы user_id хранился в событии,
    // здесь он повис бы на удалённой строке.
    const telegramId = `tg-merge-${++seq}`;
    const webSessionId = `sess-merge-${seq}`;
    await makeUser({ telegramId });
    const webUser = await makeUser({ telegramId: null, webSessionId });

    await insertAnalyticsEvents(db, [
      {
        eventKey: `${webSessionId}-view`,
        name: 'page_view',
        channel: 'web',
        origin: 'client',
        webSessionId,
        occurredAt: new Date(),
      },
    ]);

    const token = await createLinkToken(db, { webSessionId });
    const consumed = await consumeLinkToken(db, { token: token.token, telegramId });
    expect(consumed.ok && consumed.merged).toBe(true);

    // Веб-строка удалена...
    const gone = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, webUser.id));
    expect(gone).toHaveLength(0);

    // ...а событие резолвится на выжившую telegram-строку.
    const resolved = await db.execute<{ user_id: string | null }>(
      sql`SELECT user_id FROM analytics_timeline WHERE web_session_hash = left(md5(${webSessionId}), 12) AND kind = 'event'`,
    );
    expect(resolved).toHaveLength(1);
    expect(firstOf(resolved, 'resolved').user_id).toBe(consumed.ok ? consumed.userId : null);
  });

  it('денежные вехи попадают в ленту из order_events, а не из телеметрии', async () => {
    const user = await makeUser();
    const { order } = await makeOrderWithPendingPayment({ userId: user.id });

    const names = await db.execute<{ name: string; kind: string }>(sql`
      SELECT name, kind FROM analytics_timeline
      WHERE order_id = ${order.id} ORDER BY occurred_at
    `);

    // order_created пишет createDraftOrder — телеметрия его не дублирует.
    expect(names.map((r) => r.name)).toContain('order_proposed');
    expect(names.every((r) => r.kind === 'milestone')).toBe(true);

    const dupes = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM analytics_events WHERE name = 'order_proposed'
    `);
    expect(Number(firstOf(dupes, 'dupes').count)).toBe(0);
  });


  it('событие с обоими идентификаторами даёт РОВНО одну строку ленты', async () => {
    // Mini App шлёт cookie И подписанную initData, а до привязки этим ключам
    // соответствуют ДВЕ строки users. OR-джойн размножал одно событие на две
    // строки с разными subject_key — один человек считался за двух, причём
    // именно в непривязанном сегменте (находка ревью 2026-07-30).
    const telegramId = `tg-both-${++seq}`;
    const webSessionId = `sess-both-${seq}`;
    const tgUser = await makeUser({ telegramId });
    await makeUser({ telegramId: null, webSessionId });

    await insertAnalyticsEvents(db, [
      {
        eventKey: `${webSessionId}-cabinet`,
        name: 'cabinet_open',
        channel: 'miniapp',
        origin: 'client',
        webSessionId,
        telegramId,
        occurredAt: new Date(),
      },
    ]);

    const rows = await db.execute<{ user_id: string | null }>(sql`
      SELECT user_id FROM analytics_timeline
      WHERE name = 'cabinet_open' AND telegram_id = ${telegramId}
    `);

    expect(rows).toHaveLength(1);
    // Приоритет у telegram-строки: она переживает merge, веб-строка умирает.
    expect(firstOf(rows, 'resolved').user_id).toBe(tgUser.id);
  });

  it('воронка не двоит человека, у которого есть и cookie, и telegram', async () => {
    const telegramId = `tg-funnel-${++seq}`;
    const webSessionId = `sess-funnel-${seq}`;
    await makeUser({ telegramId });
    await makeUser({ telegramId: null, webSessionId });

    await insertAnalyticsEvents(db, [
      {
        eventKey: `${webSessionId}-pv`,
        name: 'page_view',
        channel: 'web',
        origin: 'client',
        webSessionId,
        telegramId,
        occurredAt: new Date(),
      },
    ]);

    const subjects = await db.execute<{ subject_key: string }>(sql`
      SELECT DISTINCT subject_key FROM analytics_timeline
      WHERE name = 'page_view' AND telegram_id = ${telegramId}
    `);
    expect(subjects).toHaveLength(1);
  });

  it('путь считает паузы и режет сессии по разрыву 30 минут', async () => {
    const webSessionId = `sess-path-${++seq}`;
    const t0 = new Date('2026-07-20T10:00:00.000Z');
    const mk = (n: number, offsetMs: number, name: string) => ({
      eventKey: `${webSessionId}-${n}`,
      name,
      channel: 'web',
      origin: 'client' as const,
      webSessionId,
      occurredAt: new Date(t0.getTime() + offsetMs),
    });

    await insertAnalyticsEvents(db, [
      mk(1, 0, 'page_view'),
      mk(2, 20_000, 'catalog_open'),
      // Разрыв 45 минут — новый заход.
      mk(3, 45 * 60_000, 'page_view'),
    ]);
    await syncAnalyticsDictionary(db, analyticsDictionaryRows());

    const path = await db.execute<{
      name: string;
      title: string;
      pause: unknown;
      session_no: number;
    }>(sql`
      SELECT name, title, pause, session_no FROM analytics_user_path
      WHERE web_session_hash = left(md5(${webSessionId}), 12) ORDER BY occurred_at
    `);

    expect(path).toHaveLength(3);
    // Человеческие подписи приезжают из словаря, а не хардкодятся в отчёте.
    expect(firstOf(path, 'first').title).toBe('Зашёл на сайт');
    expect(firstOf(path, 'first').pause).toBeNull();
    expect(Number(path[2]?.session_no)).toBe(2);
    expect(Number(path[1]?.session_no)).toBe(1);
  });

  it('воронка отдаёт семь шагов по порядку и не включает привязку Telegram', async () => {
    await syncAnalyticsDictionary(db, analyticsDictionaryRows());
    const funnel = await db.execute<{ step: number; name: string; subjects: string }>(
      sql`SELECT step, name, subjects::text FROM analytics_funnel`,
    );
    expect(funnel.map((r) => Number(r.step))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(firstOf(funnel, 'step 1').name).toBe('page_view');
    // Привязка обязательна только для веб-пути — как шаг она ломала монотонность.
    expect(funnel.map((r) => r.name)).not.toContain('telegram_linked');
  });
});

/**
 * Инварианты 7 и 8 CLAUDE.md — ПОВЕДЕНЧЕСКИ, под реальными ролями.
 *
 * До 2026-08-12 ни один тест не работал под `anon`: RLS проверялся только тем,
 * что миграции применились. То есть снятая политика или лишний GRANT (одна
 * строка в новой миграции) оставляли CI зелёным, а браузерный ключ получал
 * доступ к клиентским данным. Здесь мы реально переключаем роль.
 *
 * Проверка сформулирована как «доступа НЕТ», без различения способа отказа:
 * при включённом RLS без политик Postgres отвечает либо ошибкой прав (нет
 * GRANT), либо пустой выборкой (GRANT есть, политики нет) — для инварианта
 * важно ровно то, что данные не видны.
 */
describe('RLS: инварианты 7 и 8 под ролью anon', () => {
  type RoleResult = { rows: unknown[] } | { error: string };

  async function asRole(role: string, query: string): Promise<RoleResult> {
    await pg.exec(`SET ROLE ${role}`);
    try {
      const res = await pg.query(query);
      return { rows: res.rows };
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      await pg.exec('RESET ROLE');
    }
  }

  function denied(res: RoleResult): boolean {
    return 'error' in res || res.rows.length === 0;
  }

  const USER_TABLES = [
    'users',
    'orders',
    'order_events',
    'payments',
    'cards',
    'messages',
    'conversations',
    'link_tokens',
    'referral_partners',
    'referral_accruals',
    'referral_payouts',
    'vpn_subscriptions',
  ];

  beforeAll(async () => {
    // Каталог: одна активная запись и одна скрытая.
    await db.execute(sql`
      INSERT INTO services (slug, name, category, is_active)
      VALUES ('rls-active', 'Видимый', 'streaming', true),
             ('rls-hidden', 'Скрытый', 'streaming', false)
      ON CONFLICT (slug) DO NOTHING
    `);
    await makeUser({ telegramId: 'tg-rls-probe' });
  });

  it('инвариант 7: anon читает ТОЛЬКО активный каталог', async () => {
    const res = await asRole('anon', `SELECT slug FROM services ORDER BY slug`);
    expect('error' in res).toBe(false);
    const slugs = (res as { rows: { slug: string }[] }).rows.map((r) => r.slug);
    expect(slugs).toContain('rls-active');
    expect(slugs).not.toContain('rls-hidden');
  });

  it('инвариант 7: каталог не public-write — INSERT/UPDATE/DELETE под anon отбиты', async () => {
    const insert = await asRole(
      'anon',
      `INSERT INTO services (slug, name, category, is_active) VALUES ('rls-evil','Взлом','streaming',true)`,
    );
    const update = await asRole('anon', `UPDATE services SET name = 'Подмена' WHERE slug = 'rls-active'`);
    const del = await asRole('anon', `DELETE FROM services WHERE slug = 'rls-active'`);
    expect('error' in insert).toBe(true);
    expect('error' in update).toBe(true);
    expect('error' in del).toBe(true);

    // И ничего не изменилось на самом деле.
    const rows = await db.execute<{ name: string }>(
      sql`SELECT name FROM services WHERE slug = 'rls-active'`,
    );
    expect(firstOf(rows, 'services row').name).toBe('Видимый');
    const evil = await db.execute(sql`SELECT 1 FROM services WHERE slug = 'rls-evil'`);
    expect(evil).toHaveLength(0);
  });

  it.each(USER_TABLES)('инвариант 8: anon не читает %s', async (table) => {
    expect(denied(await asRole('anon', `SELECT * FROM ${table} LIMIT 1`))).toBe(true);
  });

  it.each(USER_TABLES)('инвариант 8: authenticated тоже не читает %s', async (table) => {
    // `authenticated` — та же браузерная поверхность (Supabase-совместимость):
    // позитивных политик под неё нет, поэтому доступа быть не должно.
    expect(denied(await asRole('authenticated', `SELECT * FROM ${table} LIMIT 1`))).toBe(true);
  });

  it('anon не пишет в user-таблицы', async () => {
    const ins = await asRole('anon', `INSERT INTO users (telegram_id) VALUES ('tg-rls-evil')`);
    expect('error' in ins).toBe(true);
    const rows = await db.execute(sql`SELECT 1 FROM users WHERE telegram_id = 'tg-rls-evil'`);
    expect(rows).toHaveLength(0);
  });

  it('у service_role есть BYPASSRLS — без него серверная роль читала бы ноль строк', async () => {
    // Табличных GRANT'ов этой роли наш контур не выдаёт (сервер ходит под
    // владельцем БД), поэтому проверяем именно атрибут: он — причина, по
    // которой deny-by-default RLS не гасит серверный доступ (E-9).
    const rows = await db.execute<{ rolbypassrls: boolean }>(
      sql`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role'`,
    );
    expect(firstOf(rows, 'service_role').rolbypassrls).toBe(true);
  });

  it('anon и authenticated под RLS — BYPASSRLS у них быть не должно', async () => {
    const rows = await db.execute<{ rolname: string; rolbypassrls: boolean }>(
      sql`SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('anon','authenticated')`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.rolbypassrls === false)).toBe(true);
  });

  it('серверное подключение видит и скрытый каталог (seed идёт мимо public-read policy)', async () => {
    const rows = await db.execute(sql`SELECT 1 FROM services WHERE slug = 'rls-hidden'`);
    expect(rows).toHaveLength(1);
  });
});
