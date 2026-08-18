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
import { appendMessage, deleteOldMessages } from './repositories/messages.ts';
import {
  appendOrderEvent,
  PAYMENT_REVIEW_CLIENT_NOTIFIED_EVENT,
  PAYMENT_REMINDER_FAILED_EVENT,
  PAYMENT_REMINDER_SENT_EVENT,
  claimPaymentReminder,
  claimRenewalReminder,
  countRefundishHistoryByUser,
  createDraftOrder,
  findExpiredPayableOrders,
  findStuckInFulfillmentOrders,
  getOrderById,
  getOrderEventsByOrderId,
  hasPurchasedOrders,
  findStaleOrdersInPaymentReview,
  setOrderExpiresAt,
  transitionOrderDetailed,
} from './repositories/orders.ts';
import {
  findPendingPaymentsForPoll,
  setPaymentProviderStatus,
} from './repositories/payments.ts';
import { nextFreekassaNonce } from './repositories/freekassa.ts';
import {
  createConversation,
  getOrCreateActiveConversation,
} from './repositories/conversations.ts';
import { countInvoiceConversion } from './repositories/payments.ts';
import { consumeLinkToken, createLinkToken } from './repositories/link-tokens.ts';
import { setReferrerOnce } from './repositories/referrals.ts';
import {
  getOrCreateUserByTelegramId,
  getPayerPhoneForOrder,
  getUserPayerContact,
  touchUserLastSeenIp,
  updateUserContacts,
} from './repositories/users.ts';
import {
  getReferralBalanceUsdCents,
  insertCommissionAccruals,
  reverseAccrualsForOrder,
  findOrdersMissingReferralAccruals,
  findOrdersWithUnreversedAccruals,
  findPurchasedOrdersWithReversedAccruals,
  findNegativeReferralBalances,
} from './repositories/referral-accruals.ts';
import {
  createReferralPayout,
  findReferralPayoutForPanel,
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
  PANEL_DEFAULT_ROWS,
  PANEL_MAX_ROWS,
  clampPanelLimit,
  clampPanelOffset,
  getClientDetailForPanel,
  getOrderDetailForPanel,
  listHoldsForPanel,
  listPendingOrdersForPanel,
  countPendingOrdersForPanel,
  listSupportRequestsForPanel,
  listReferralPartnersForPanel,
  listPartnerReferralsForPanel,
  listReferralPayoutsForPanel,
  countUnansweredSupportRequests,
  getSupportThreadForPanel,
  claimSupportConversation,
  listOrdersForPanel,
} from './repositories/panel.ts';
import {
  claimStaffTotpStep,
  confirmStaffTotp,
  findStaffById,
  findStaffByTelegramId,
  listStaff,
  resetStaffTotpByTelegramId,
  setStaffActiveByTelegramId,
  startStaffTotpEnrollment,
  touchStaffLastLogin,
  upsertStaffByTelegramId,
} from './repositories/staff.ts';
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

describe('payment_review (антифрод-трек: заказ «на проверке банка»)', () => {
  it('pending_payment → payment_review → paid проходит через transitionOrder', async () => {
    const user = await makeUser();
    const { order } = await makeOrderWithPendingPayment({ userId: user.id });

    const toReview = await transitionOrderDetailed(db, {
      orderId: order.id,
      toStatus: 'payment_review',
      actorType: 'payment_provider',
      payload: { reason: 'antifraud_hold' },
    });
    expect(toReview.transitioned).toBe(true);

    // Оплата подтвердилась после холда — обычный путь paid работает и отсюда.
    const toPaid = await transitionOrderDetailed(db, {
      orderId: order.id,
      toStatus: 'paid',
      actorType: 'payment_provider',
    });
    expect(toPaid.transitioned).toBe(true);
    expect(toPaid.order.status).toBe('paid');
  });

  it('payment_review не достижим из ready_for_payment и не уходит в expired', async () => {
    const user = await makeUser();
    const draft = await createDraftOrder(db, {
      userId: user.id,
      status: 'ready_for_payment',
      customServiceDescription: 'integration-test order',
      amountRub: 50000,
    });
    await expect(
      transitionOrderDetailed(db, { orderId: draft.id, toStatus: 'payment_review' }),
    ).rejects.toBeInstanceOf(OrderTransitionError);

    const { order } = await makeOrderWithPendingPayment({ userId: user.id });
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'payment_review' });
    await expect(
      transitionOrderDetailed(db, { orderId: order.id, toStatus: 'expired' }),
    ).rejects.toBeInstanceOf(OrderTransitionError);
  });

  it('экспайр НЕ хоронит payment_review даже с истёкшим expires_at', async () => {
    // Конец истории «оплатил, а получил „срок оплаты истёк“»: заказ с
    // (возможно) зафиксированными деньгами не протухает по таймеру.
    const user = await makeUser();
    const { order } = await makeOrderWithPendingPayment({
      userId: user.id,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'payment_review' });

    const expired = await findExpiredPayableOrders(db);
    expect(expired.map((o) => o.id)).not.toContain(order.id);
  });

  it('findStaleOrdersInPaymentReview: старше порога — виден, свежий — нет', async () => {
    const user = await makeUser();
    const { order: fresh } = await makeOrderWithPendingPayment({ userId: user.id });
    await transitionOrderDetailed(db, { orderId: fresh.id, toStatus: 'payment_review' });

    // Возраст меряется по событию входа в payment_review (append-only journal),
    // а не по updated_at: тот не трогается переходами. Состарить событие можно
    // только руками: UPDATE отвергает append-only-триггер (и это правильно),
    // поэтому на время бэкдейта триггер отключается — симуляция времени, не
    // обход инварианта в продовом коде.
    const { order: stale } = await makeOrderWithPendingPayment({ userId: user.id });
    await transitionOrderDetailed(db, { orderId: stale.id, toStatus: 'payment_review' });
    await pg.exec('ALTER TABLE order_events DISABLE TRIGGER order_events_append_only');
    await db.execute(sql`
      UPDATE order_events SET created_at = now() - interval '8 days'
      WHERE order_id = ${stale.id} AND to_status = 'payment_review'
    `);
    await pg.exec('ALTER TABLE order_events ENABLE TRIGGER order_events_append_only');

    const found = await findStaleOrdersInPaymentReview(db, {
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
    });
    const ids = found.map((o) => o.id);
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(fresh.id);
  });

  it('платёж под холдом опрашивается и после 25-часового окна', async () => {
    // Холд может висеть дольше суток; без исключения в findPendingPaymentsForPoll
    // такой платёж выпадал бы из добора, и разрешение холда мы бы не увидели.
    const user = await makeUser();
    const { order, payment } = await makeOrderWithPendingPayment({ userId: user.id });
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'payment_review' });
    await db.execute(
      sql`UPDATE payments SET created_at = now() - interval '30 hours' WHERE id = ${payment.id}`,
    );

    const polled = await findPendingPaymentsForPoll(db);
    expect(polled.map((p) => p.id)).toContain(payment.id);

    // Контроль: столь же старый платёж обычного pending_payment-заказа в
    // выборку не попадает — верхняя граница для него работает как раньше.
    const { payment: ordinary } = await makeOrderWithPendingPayment({ userId: user.id });
    await db.execute(
      sql`UPDATE payments SET created_at = now() - interval '30 hours' WHERE id = ${ordinary.id}`,
    );
    const polled2 = await findPendingPaymentsForPoll(db);
    expect(polled2.map((p) => p.id)).not.toContain(ordinary.id);
  });

  it('setPaymentProviderStatus пишет код и момент опроса', async () => {
    const user = await makeUser();
    const { payment } = await makeOrderWithPendingPayment({ userId: user.id });

    await setPaymentProviderStatus(db, { paymentId: payment.id, providerStatus: 7 });

    const rows = await db.execute<{ last_provider_status: number; last_provider_status_at: string | Date }>(
      sql`SELECT last_provider_status, last_provider_status_at FROM payments WHERE id = ${payment.id}`,
    );
    expect(rows[0]?.last_provider_status).toBe(7);
    expect(rows[0]?.last_provider_status_at).not.toBeNull();
  });
});

describe('countRefundishHistoryByUser (учёт возвратов, тикет 11)', () => {
  it('считает недоплаты, возвраты провайдера и refunded-заказы за окно', async () => {
    const user = await makeUser();

    // Недоплата (amount_mismatch).
    const a = await makeOrderWithPendingPayment({ userId: user.id });
    await transitionOrderDetailed(db, {
      orderId: a.order.id,
      toStatus: 'failed',
      eventType: 'payment_amount_mismatch',
      actorType: 'payment_provider',
    });
    // Возврат у провайдера (терминал с providerStatus=6).
    const b = await makeOrderWithPendingPayment({ userId: user.id });
    await transitionOrderDetailed(db, {
      orderId: b.order.id,
      toStatus: 'cancelled',
      eventType: 'payment_cancelled',
      actorType: 'payment_provider',
      payload: { providerStatus: 6 },
    });
    // Дошедший до refunded.
    const c = await makeOrderWithPendingPayment({ userId: user.id });
    await transitionOrderDetailed(db, { orderId: c.order.id, toStatus: 'paid' });
    await transitionOrderDetailed(db, { orderId: c.order.id, toStatus: 'refund_requested' });
    await transitionOrderDetailed(db, { orderId: c.order.id, toStatus: 'refunded' });
    // Обычная отмена — НЕ считается.
    const d = await makeOrderWithPendingPayment({ userId: user.id });
    await transitionOrderDetailed(db, {
      orderId: d.order.id,
      toStatus: 'cancelled',
      eventType: 'payment_cancelled',
      actorType: 'payment_provider',
      payload: { providerStatus: 9 },
    });

    expect(await countRefundishHistoryByUser(db, { userId: user.id, withinDays: 180 })).toBe(3);

    // Чужая история не подмешивается.
    const other = await makeUser();
    expect(await countRefundishHistoryByUser(db, { userId: other.id, withinDays: 180 })).toBe(0);
  });
});

describe('touchUserLastSeenIp (антифрод-трек: последний живой IP клиента)', () => {
  async function readIpState(userId: string) {
    const rows = await db
      .select({ ip: schema.users.lastSeenIp, at: schema.users.lastSeenIpAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return firstOf(rows, 'users last_seen_ip');
  }

  it('первый визит пишет IP и момент', async () => {
    const user = await makeUser();

    const updated = await touchUserLastSeenIp(db, { userId: user.id, ip: '203.0.113.5' });

    expect(updated).toBe(true);
    const state = await readIpState(user.id);
    expect(state.ip).toBe('203.0.113.5');
    expect(state.at).toBeInstanceOf(Date);
  });

  it('тот же IP в пределах 10 минут — UPDATE не выполняется (троттлинг)', async () => {
    // Листание кабинета — десятки запросов в минуту; без троттлинга каждый тап
    // генерировал бы UPDATE по users.
    const user = await makeUser();
    await touchUserLastSeenIp(db, { userId: user.id, ip: '203.0.113.5' });
    const before = await readIpState(user.id);

    const updated = await touchUserLastSeenIp(db, { userId: user.id, ip: '203.0.113.5' });

    expect(updated).toBe(false);
    const after = await readIpState(user.id);
    expect(after.at?.getTime()).toBe(before.at?.getTime());
  });

  it('смена IP обновляет запись сразу, не дожидаясь 10 минут', async () => {
    // Свежесть адреса важнее экономии UPDATE'ов: счёт уходит провайдеру с
    // ПОСЛЕДНИМ адресом, и клиент мог переключиться с Wi-Fi на LTE за минуту.
    const user = await makeUser();
    await touchUserLastSeenIp(db, { userId: user.id, ip: '203.0.113.5' });

    const updated = await touchUserLastSeenIp(db, { userId: user.id, ip: '198.51.100.7' });

    expect(updated).toBe(true);
    expect((await readIpState(user.id)).ip).toBe('198.51.100.7');
  });

  it('тот же IP, но метка старше 10 минут — освежаем момент', async () => {
    const user = await makeUser();
    await touchUserLastSeenIp(db, { userId: user.id, ip: '203.0.113.5' });
    await db.execute(
      sql`UPDATE users SET last_seen_ip_at = now() - interval '11 minutes' WHERE id = ${user.id}`,
    );
    const before = await readIpState(user.id);

    const updated = await touchUserLastSeenIp(db, { userId: user.id, ip: '203.0.113.5' });

    expect(updated).toBe(true);
    const after = await readIpState(user.id);
    expect(after.at!.getTime()).toBeGreaterThan(before.at!.getTime());
  });
});

describe('getUserPayerContact (данные плательщика для счёта Freekassa)', () => {
  it('отдаёт telegram_id, email, phone и last_seen_ip одной строкой', async () => {
    const user = await makeUser({
      email: 'client@example.com',
      phone: '+79991234567',
      lastSeenIp: '203.0.113.5',
    });

    const contact = await getUserPayerContact(db, user.id);

    expect(contact).toMatchObject({
      telegramId: user.telegramId,
      email: 'client@example.com',
      phone: '+79991234567',
      lastSeenIp: '203.0.113.5',
    });
  });

  it('незаполненные контакты — null, незнакомый пользователь — null целиком', async () => {
    const user = await makeUser();

    const contact = await getUserPayerContact(db, user.id);
    expect(contact).toMatchObject({ email: null, phone: null, lastSeenIp: null });

    expect(await getUserPayerContact(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('updateUserContacts пишет email; вызов без полей — noop', async () => {
    const user = await makeUser();

    await updateUserContacts(db, { userId: user.id, email: 'client@example.com' });
    expect((await getUserPayerContact(db, user.id))?.email).toBe('client@example.com');

    await updateUserContacts(db, { userId: user.id });
    expect((await getUserPayerContact(db, user.id))?.email).toBe('client@example.com');
  });

  it('телефон едет парой с источником; ручная правка перекрывает telegram-источник', async () => {
    // Тикет 05/08: номер без пометки «кто его дал» бесполезен сверке; ручная
    // правка сбрасывает источник в manual (Р4 — номер СБП может отличаться).
    const user = await makeUser();

    await updateUserContacts(db, {
      userId: user.id,
      phone: '+79991234567',
      phoneSource: 'telegram',
    });
    let contact = await getUserPayerContact(db, user.id);
    expect(contact).toMatchObject({ phone: '+79991234567', phoneSource: 'telegram' });

    await updateUserContacts(db, {
      userId: user.id,
      phone: '+79997654321',
      phoneSource: 'manual',
    });
    contact = await getUserPayerContact(db, user.id);
    expect(contact).toMatchObject({ phone: '+79997654321', phoneSource: 'manual' });
    // email при этом не тронут.
    expect(contact?.email).toBeNull();
  });

  it('getPayerPhoneForOrder отдаёт номер владельца заказа', async () => {
    const user = await makeUser({ phone: '+79991234567', phoneSource: 'telegram' });
    const { order } = await makeOrderWithPendingPayment({ userId: user.id });

    expect(await getPayerPhoneForOrder(db, order.id)).toEqual({
      phone: '+79991234567',
      phoneSource: 'telegram',
    });
    expect(await getPayerPhoneForOrder(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('consumeLinkToken (merge пользователей)', () => {
  it('merge переносит контакты и last_seen_ip веб-строки (антифрод-трек)', async () => {
    // Основной сценарий сайта: клиент ввёл почту в плашке (веб-строка), затем
    // привязал Telegram. Merge удаляет веб-строку — без переноса почта и адрес
    // терялись бы ровно между вводом и выставлением счёта.
    const webSessionId = `ws-contact-${++seq}`;
    await makeUser({
      telegramId: null,
      webSessionId,
      email: 'client@example.com',
      phone: '+79991234567',
      lastSeenIp: '203.0.113.5',
      lastSeenIpAt: new Date(),
    });
    const telegramUser = await makeUser();

    const { token } = await createLinkToken(db, { webSessionId });
    const res = await consumeLinkToken(db, { token, telegramId: telegramUser.telegramId ?? '' });
    expect(res.ok).toBe(true);

    const contact = await getUserPayerContact(db, telegramUser.id);
    expect(contact).toMatchObject({
      email: 'client@example.com',
      phone: '+79991234567',
      lastSeenIp: '203.0.113.5',
    });
  });

  it('merge НЕ перетирает контакты telegram-строки почтой веб-строки', async () => {
    // COALESCE-семантика: у выжившей строки приоритет — как у display_name.
    const webSessionId = `ws-contact2-${++seq}`;
    await makeUser({ telegramId: null, webSessionId, email: 'web@example.com' });
    const telegramUser = await makeUser({ email: 'tg@example.com' });

    const { token } = await createLinkToken(db, { webSessionId });
    await consumeLinkToken(db, { token, telegramId: telegramUser.telegramId ?? '' });

    expect((await getUserPayerContact(db, telegramUser.id))?.email).toBe('tg@example.com');
  });

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
    expect((await findOrdersWithUnreversedAccruals(db, 50)).map((f) => f.orderId)).not.toContain(
      first.order.id,
    );
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

    expect((await findOrdersWithUnreversedAccruals(db, 50)).map((f) => f.orderId)).toContain(
      order.id,
    );
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

describe('findNegativeReferralBalances (отмена поверх заявки на вывод)', () => {
  it('ловит партнёра, у которого отмена ушла ниже поданной заявки', async () => {
    const partner = await makeUser();
    const buyer = await makeUser({ referredBy: partner.id, referredBySetAt: new Date() });
    const { order, payment } = await makeOrderWithPendingPayment({ userId: buyer.id });
    await claimPaymentSucceeded(db, { paymentId: payment.id });
    await insertCommissionAccruals(db, {
      sourceUserId: buyer.id,
      orderId: order.id,
      paymentId: payment.id,
      rows: [{ beneficiaryUserId: partner.id, level: 1, rateBps: 400, amountUsdCents: 1000 }],
    });
    // Партнёр успел подать заявку на весь баланс — она уже вычтена.
    await createReferralPayout(db, { userId: partner.id, amountUsdCents: 1000 });
    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(0);

    // Заказ провалился: отмена вычитает те же деньги второй раз.
    await db.execute(sql`UPDATE orders SET status = 'failed' WHERE id = ${order.id}`);
    await reverseAccrualsForOrder(db, order.id);

    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(-1000);
    const negative = await findNegativeReferralBalances(db, 50);
    expect(negative).toContainEqual({ userId: partner.id, balanceUsdCents: -1000 });
  });

  it('здоровые партнёры в выборку не попадают', async () => {
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

    const negative = await findNegativeReferralBalances(db, 50);
    expect(negative.map((n) => n.userId)).not.toContain(partner.id);
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

    expect(found.map((f) => f.orderId)).toContain(order.id);
  });

  it('после отмены заказ из выборки уходит — крон не крутит его вечно', async () => {
    const { order } = await makeAccruedOrder('failed');
    await reverseAccrualsForOrder(db, order.id);

    expect((await findOrdersWithUnreversedAccruals(db, 50)).map((f) => f.orderId)).not.toContain(
      order.id,
    );
  });

  it('живые заказы не трогает: paid и completed остаются с начислениями', async () => {
    const paid = await makeAccruedOrder('paid');
    const completed = await makeAccruedOrder('completed');

    const found = await findOrdersWithUnreversedAccruals(db, 50);

    const ids = found.map((f) => f.orderId);
    expect(ids).not.toContain(paid.order.id);
    expect(ids).not.toContain(completed.order.id);
  });
});

// Зеркало предыдущего блока. Сверка ловила только «партнёру переплатили» — там,
// где теряем мы; сторона, где теряет партнёр, не проверялась вовсе (находка
// финального ревью). Путь реальный: заказ упал при НЕИЗВЕСТНОМ исходе топапа,
// начисление погашено, потом оператор довёл заказ до completed.
describe('findPurchasedOrdersWithReversedAccruals (недоплата партнёру)', () => {
  async function makeReversedOrder(finalStatus: 'completed' | 'failed' | 'refunded') {
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
    await db.execute(sql`UPDATE orders SET status = 'failed' WHERE id = ${order.id}`);
    expect(await reverseAccrualsForOrder(db, order.id)).toBe(1);
    await db.execute(sql`UPDATE orders SET status = ${finalStatus} WHERE id = ${order.id}`);
    return { partner, order };
  }

  it('воскрешённый заказ с погашенной комиссией виден сверке', async () => {
    const { order } = await makeReversedOrder('completed');

    const found = await findPurchasedOrdersWithReversedAccruals(db, 50);

    expect(found.map((f) => f.orderId)).toContain(order.id);
    expect(found.find((f) => f.orderId === order.id)?.status).toBe('completed');
  });

  it('штатно погашенный заказ сигналом не считается', async () => {
    const failed = await makeReversedOrder('failed');
    const refunded = await makeReversedOrder('refunded');

    const ids = (await findPurchasedOrdersWithReversedAccruals(db, 50)).map((f) => f.orderId);

    expect(ids).not.toContain(failed.order.id);
    expect(ids).not.toContain(refunded.order.id);
  });

  it('баланс партнёра после воскрешения действительно занижен', async () => {
    // Цифра — суть находки: комиссия начислена ($1.00) и погашена, заказ при
    // этом состоялся. Ноль здесь означает, что партнёру недоплатили.
    const { partner } = await makeReversedOrder('completed');

    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(0);
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

describe('staff (вход в админ-панель: Telegram + TOTP)', () => {
  async function makeStaff(over: Partial<typeof schema.staff.$inferInsert> = {}) {
    const n = ++seq;
    const rows = await db
      .insert(schema.staff)
      .values({
        email: `staff-${n}@example.com`,
        displayName: `Сотрудник ${n}`,
        telegramId: `tg-staff-${n}`,
        role: 'admin',
        ...over,
      })
      .returning();
    return firstOf(rows, 'staff insert');
  }

  it('поиск по telegram_id находит сотрудника и отдаёт всё нужное для входа', async () => {
    const created = await makeStaff({ role: 'operator' });

    const found = await findStaffByTelegramId(db, created.telegramId!);

    expect(found).toMatchObject({
      id: created.id,
      role: 'operator',
      isActive: true,
      totpSecret: null,
      totpConfirmedAt: null,
    });
  });

  it('неизвестный telegram_id — null (отказ без подробностей строит вызывающий)', async () => {
    expect(await findStaffByTelegramId(db, 'tg-staff-нет-такого')).toBeNull();
  });

  it('отключённый сотрудник ВИДЕН репозиторию — решение об отказе принимает панель', async () => {
    const created = await makeStaff({ isActive: false });

    const found = await findStaffByTelegramId(db, created.telegramId!);

    expect(found?.isActive).toBe(false);
  });

  it('два сотрудника с одним telegram_id невозможны — иначе «кто вошёл» решает планировщик', async () => {
    await makeStaff({ telegramId: 'tg-staff-dup' });

    await expect(makeStaff({ telegramId: 'tg-staff-dup' })).rejects.toSatisfy((err: unknown) =>
      pgErrorMatches(err, /duplicate key|unique/i),
    );
  });

  it('привязка TOTP: секрет пишется новичку', async () => {
    const created = await makeStaff();

    const ok = await startStaffTotpEnrollment(db, { staffId: created.id, secret: 'SECRET1' });

    expect(ok).toBe(true);
    expect((await findStaffById(db, created.id))?.totpSecret).toBe('SECRET1');
  });

  it('привязка не доведена до кода — следующий вход выдаёт НОВЫЙ секрет', async () => {
    const created = await makeStaff();
    await startStaffTotpEnrollment(db, { staffId: created.id, secret: 'SECRET1' });

    const ok = await startStaffTotpEnrollment(db, { staffId: created.id, secret: 'SECRET2' });

    expect(ok).toBe(true);
    expect((await findStaffById(db, created.id))?.totpSecret).toBe('SECRET2');
  });

  it('подтверждённый TOTP перевыдать нельзя — иначе угон Telegram сбрасывал бы второй фактор', async () => {
    const created = await makeStaff();
    await startStaffTotpEnrollment(db, { staffId: created.id, secret: 'SECRET1' });
    await confirmStaffTotp(db, { staffId: created.id, expectedSecret: 'SECRET1' });

    const ok = await startStaffTotpEnrollment(db, { staffId: created.id, secret: 'EVIL' });

    expect(ok).toBe(false);
    expect((await findStaffById(db, created.id))?.totpSecret).toBe('SECRET1');
  });

  it('подтверждение TOTP срабатывает один раз', async () => {
    const created = await makeStaff();
    await startStaffTotpEnrollment(db, { staffId: created.id, secret: 'SECRET1' });

    const args = { staffId: created.id, expectedSecret: 'SECRET1' };
    expect(await confirmStaffTotp(db, args)).toBe(true);
    expect(await confirmStaffTotp(db, args)).toBe(false);
    expect((await findStaffById(db, created.id))?.totpConfirmedAt).toBeInstanceOf(Date);
  });

  it('подтвердить TOTP без секрета невозможно', async () => {
    const created = await makeStaff();

    expect(
      await confirmStaffTotp(db, { staffId: created.id, expectedSecret: 'SECRET1' }),
    ).toBe(false);
    expect((await findStaffById(db, created.id))?.totpConfirmedAt).toBeNull();
  });

  it('успешный вход отмечается временем', async () => {
    const created = await makeStaff();
    expect(created.lastLoginAt).toBeNull();

    await touchStaffLastLogin(db, created.id);

    expect((await findStaffById(db, created.id))?.lastLoginAt).toBeInstanceOf(Date);
  });

  it('заведение сотрудника идемпотентно по telegram_id — повтор скрипта не плодит строк', async () => {
    const first = await upsertStaffByTelegramId(db, {
      telegramId: 'tg-staff-upsert',
      email: 'upsert@example.com',
      displayName: 'Владелец',
      role: 'admin',
    });
    const second = await upsertStaffByTelegramId(db, {
      telegramId: 'tg-staff-upsert',
      email: 'upsert@example.com',
      displayName: 'Владелец (переименован)',
      role: 'admin',
    });

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe('Владелец (переименован)');
  });

  it('повторное заведение НЕ сбрасывает второй фактор — иначе скрипт молча снимал бы защиту', async () => {
    const created = await upsertStaffByTelegramId(db, {
      telegramId: 'tg-staff-keep-totp',
      email: 'keep-totp@example.com',
      displayName: 'Сотрудник',
      role: 'operator',
    });
    await startStaffTotpEnrollment(db, { staffId: created.id, secret: 'KEEPME' });
    await confirmStaffTotp(db, { staffId: created.id, expectedSecret: 'KEEPME' });

    await upsertStaffByTelegramId(db, {
      telegramId: 'tg-staff-keep-totp',
      email: 'keep-totp@example.com',
      displayName: 'Сотрудник',
      role: 'admin',
    });

    const after = await findStaffById(db, created.id);
    expect(after?.totpSecret).toBe('KEEPME');
    expect(after?.totpConfirmedAt).toBeInstanceOf(Date);
    expect(after?.role).toBe('admin');
  });

  it('перевыдача TOTP потерявшему телефон стирает и секрет, и подтверждение', async () => {
    const created = await makeStaff();
    await startStaffTotpEnrollment(db, { staffId: created.id, secret: 'OLD' });
    await confirmStaffTotp(db, { staffId: created.id, expectedSecret: 'OLD' });

    const reset = await resetStaffTotpByTelegramId(db, created.telegramId!);

    expect(reset).toBe(true);
    const after = await findStaffById(db, created.id);
    expect(after?.totpSecret).toBeNull();
    expect(after?.totpConfirmedAt).toBeNull();
  });

  it('отключение доступа работает по telegram_id', async () => {
    const created = await makeStaff();

    expect(await setStaffActiveByTelegramId(db, created.telegramId!, false)).toBe(true);
    expect((await findStaffById(db, created.id))?.isActive).toBe(false);
  });

  it('подтверждение сверяет секрет: соседняя вкладка перевыдала — чужой не подтверждается', async () => {
    const created = await makeStaff();
    await startStaffTotpEnrollment(db, { staffId: created.id, secret: 'S1' });
    // Вкладка B прошла первый фактор заново и перезаписала секрет.
    await startStaffTotpEnrollment(db, { staffId: created.id, secret: 'S2' });

    // Вкладка A досчитала код от S1 и пытается подтвердить.
    const confirmed = await confirmStaffTotp(db, {
      staffId: created.id,
      expectedSecret: 'S1',
    });

    expect(confirmed).toBe(false);
    const after = await findStaffById(db, created.id);
    // Иначе подтверждённым стал бы S2, которым никто владения не доказал, —
    // и сотрудник заперт до ручного reset-totp.
    expect(after?.totpConfirmedAt).toBeNull();
    expect(after?.totpSecret).toBe('S2');
  });

  it('окно TOTP занимается один раз — код не переигрывается', async () => {
    const created = await makeStaff();

    expect(await claimStaffTotpStep(db, { staffId: created.id, step: 1000 })).toBe(true);
    expect(await claimStaffTotpStep(db, { staffId: created.id, step: 1000 })).toBe(false);
    expect((await findStaffById(db, created.id))?.totpLastStep).toBe(1000);
  });

  it('старое окно из допуска +-1 тоже не принимается повторно', async () => {
    const created = await makeStaff();
    await claimStaffTotpStep(db, { staffId: created.id, step: 1000 });

    expect(await claimStaffTotpStep(db, { staffId: created.id, step: 999 })).toBe(false);
    expect(await claimStaffTotpStep(db, { staffId: created.id, step: 1001 })).toBe(true);
  });

  it('перевыдача TOTP сбрасывает и занятое окно — новый секрет начинает с чистого листа', async () => {
    const created = await makeStaff();
    await claimStaffTotpStep(db, { staffId: created.id, step: 5000 });

    await resetStaffTotpByTelegramId(db, created.telegramId!);

    expect((await findStaffById(db, created.id))?.totpLastStep).toBeNull();
  });

  it('список персонала отдаёт всех, включая отключённых', async () => {
    const active = await makeStaff();
    const disabled = await makeStaff({ isActive: false });

    const list = await listStaff(db);
    const ids = list.map((s) => s.id);

    expect(ids).toContain(active.id);
    expect(ids).toContain(disabled.id);
  });
});

describe('панель: список заказов и карточка заказа (тикет 03)', () => {
  let panelUserA: string;
  let panelUserB: string;
  let panelServiceId: string;
  let ordA1: { id: string; shortId: string };
  let ordA2: { id: string; shortId: string };
  let ordB1: { id: string; shortId: string };

  beforeAll(async () => {
    const a = await makeUser({
      telegramId: 'tg-panel-a',
      displayName: 'Клиент А',
      email: 'a@example.com',
    });
    const b = await makeUser({
      telegramId: null,
      webSessionId: 'web-panel-b',
      displayName: 'Клиент Б',
    });
    panelUserA = a.id;
    panelUserB = b.id;

    const svc = await db
      .insert(schema.services)
      .values({ slug: 'panel-spotify', name: 'Spotify', category: 'music' })
      .returning();
    panelServiceId = firstOf(svc, 'service insert').id;

    ordA1 = await createDraftOrder(db, {
      userId: panelUserA,
      status: 'pending_payment',
      serviceId: panelServiceId,
      amountRub: 123400,
      originalAmount: 1500,
      originalCurrency: 'USD',
      cardIssueFeeKopecks: 32000,
      commissionPercent: 30,
    });
    ordA2 = await createDraftOrder(db, {
      userId: panelUserA,
      status: 'completed',
      customServiceDescription: 'Подписка на что-то своё',
      amountRub: 50000,
      originalAmount: 600,
      originalCurrency: 'USD',
    });
    ordB1 = await createDraftOrder(db, {
      userId: panelUserB,
      status: 'failed',
      serviceId: panelServiceId,
      amountRub: 777700,
      originalAmount: 9000,
      originalCurrency: 'USD',
    });
  });

  it('список отдаёт всё, что нужно строке таблицы', async () => {
    const { items: rows } = await listOrdersForPanel(db, { query: ordA1.shortId });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shortId: ordA1.shortId,
      status: 'pending_payment',
      amountRubKopecks: 123400,
      serviceName: 'Spotify',
      client: { id: panelUserA, displayName: 'Клиент А', telegramId: 'tg-panel-a' },
    });
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('сервис вне каталога подписан своим описанием, а не пустотой', async () => {
    const { items: rows } = await listOrdersForPanel(db, { query: ordA2.shortId });

    expect(rows[0]?.serviceName).toBe('Подписка на что-то своё');
  });

  it('фильтр по статусу отбирает только его', async () => {
    const { items: rows } = await listOrdersForPanel(db, { statuses: ['failed'] });

    expect(rows.map((r) => r.shortId)).toContain(ordB1.shortId);
    expect(rows.every((r) => r.status === 'failed')).toBe(true);
  });

  it('поиск находит по telegram_id клиента', async () => {
    const { items: rows } = await listOrdersForPanel(db, { query: 'tg-panel-a' });

    const ids = rows.map((r) => r.shortId);
    expect(ids).toContain(ordA1.shortId);
    expect(ids).toContain(ordA2.shortId);
    expect(ids).not.toContain(ordB1.shortId);
  });

  it('поиск по email клиента', async () => {
    const { items: rows } = await listOrdersForPanel(db, { query: 'a@example.com' });

    expect(rows.map((r) => r.shortId)).toContain(ordA1.shortId);
  });

  it('поиск регистронезависим и терпит лишние пробелы', async () => {
    const { items: rows } = await listOrdersForPanel(db, {
      query: `  ${ordA1.shortId.toLowerCase()} `,
    });

    expect(rows.map((r) => r.shortId)).toContain(ordA1.shortId);
  });

  it('свежие заказы первыми', async () => {
    const { items: rows } = await listOrdersForPanel(db, { limit: 100 });
    const times = rows.map((r) => r.createdAt.getTime());

    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });

  it('размер страницы приводится к допустимому — проверяем САМ кламп', async () => {
    // Интеграционная проверка «строк не больше ста» на маленькой базе ничего не
    // доказывает: она зелёная и при потолке в сто тысяч. Поэтому проверяется
    // функция, а не следствие.
    expect(clampPanelLimit(10_000)).toBe(PANEL_MAX_ROWS);
    expect(clampPanelLimit(0)).toBe(1);
    expect(clampPanelLimit(-5)).toBe(1);
    expect(clampPanelLimit(undefined)).toBe(PANEL_DEFAULT_ROWS);
    // NaN проходил бы в LIMIT и ронял запрос.
    expect(clampPanelLimit(Number.NaN)).toBe(PANEL_DEFAULT_ROWS);
    expect(clampPanelLimit(7.9)).toBe(7);

    expect(clampPanelOffset(undefined)).toBe(0);
    expect(clampPanelOffset(-3)).toBe(0);
    expect(clampPanelOffset(Number.NaN)).toBe(0);
    expect(clampPanelOffset(25)).toBe(25);
  });

  it('запрошенный сверх потолка размер не вытягивает всю таблицу', async () => {
    const { items: rows } = await listOrdersForPanel(db, { limit: 10_000 });

    expect(rows.length).toBeLessThanOrEqual(PANEL_MAX_ROWS);
  });

  it('смещение листает, а не повторяет', async () => {
    const first = await listOrdersForPanel(db, { limit: 2 });
    const second = await listOrdersForPanel(db, { limit: 2, offset: 2 });

    const firstIds = first.items.map((r) => r.id);
    expect(second.items.every((r) => !firstIds.includes(r.id))).toBe(true);
  });

  it('пустой результат — это пустой список, а не ошибка', async () => {
    expect(await listOrdersForPanel(db, { query: 'ничего-такого-нет' })).toEqual({
      items: [],
      hasMore: false,
    });
  });

  it('карточка заказа собирает всё: цену, события, платежи', async () => {
    const { payment } = await upsertPaymentByProviderRef(db, {
      orderId: ordA1.id,
      provider: 'freekassa',
      providerRef: `panel-inv-${++seq}`,
      amountRub: 123400,
    });
    await setPaymentProviderStatus(db, { paymentId: payment.id, providerStatus: 7 });

    const detail = await getOrderDetailForPanel(db, ordA1.shortId);

    expect(detail).not.toBeNull();
    expect(detail?.order).toMatchObject({
      shortId: ordA1.shortId,
      amountRubKopecks: 123400,
      cardIssueFeeKopecks: 32000,
      commissionPercent: 30,
    });
    expect(detail?.client.id).toBe(panelUserA);
    expect(detail?.serviceName).toBe('Spotify');
    expect(detail?.events.length).toBeGreaterThan(0);
    expect(detail?.payments[0]).toMatchObject({
      provider: 'freekassa',
      amountRubKopecks: 123400,
      lastProviderStatus: 7,
    });
  });

  it('события карточки идут в хронологии', async () => {
    const detail = await getOrderDetailForPanel(db, ordA2.shortId);
    const times = (detail?.events ?? []).map((e) => e.createdAt.getTime());

    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });

  it('карта показывается ТОЛЬКО маскированной', async () => {
    const card = firstOf(
      await db
        .insert(schema.cards)
        .values({
          userId: panelUserA,
          providerCardId: `panel-card-${++seq}`,
          panMasked: '444444******1234',
          balanceUsdCents: 1500,
        })
        .returning(),
      'card insert',
    );
    await db.update(schema.orders).set({ cardId: card.id }).where(eq(schema.orders.id, ordA1.id));

    const detail = await getOrderDetailForPanel(db, ordA1.shortId);

    expect(detail?.card).toMatchObject({ panMasked: '444444******1234', balanceUsdCents: 1500 });
    // Полный PAN/CVC панель не показывает НИКОГДА: санкционированных каналов
    // выдачи ровно два, и панель третьим не становится.
    expect(JSON.stringify(detail)).not.toContain('4444444444441234');
    // Ассерт на ТОЧНЫЙ набор полей, а не «нет pan/cvc»: таких колонок в `cards`
    // нет вовсе, и отрицание выполнялось бы само собой. Здесь же любое новое
    // поле карты придётся осознанно внести в список — вместе с решением,
    // можно ли его показывать.
    expect(Object.keys(detail?.card ?? {}).sort()).toEqual([
      'balanceUsdCents',
      'createdAt',
      'id',
      'panMasked',
      'status',
    ]);
  });


  it('карточка находится по номеру в любом регистре', async () => {
    const upper = await getOrderDetailForPanel(db, ordA1.shortId);
    const lower = await getOrderDetailForPanel(db, ordA1.shortId.toLowerCase());
    const padded = await getOrderDetailForPanel(db, `  ${ordA1.shortId}  `);

    expect(upper?.order.id).toBe(ordA1.id);
    expect(lower?.order.id).toBe(ordA1.id);
    expect(padded?.order.id).toBe(ordA1.id);
  });

  it('спецсимволы LIKE в поиске — литералы, а не подстановочные знаки', async () => {
    // Оператор ищет «100%» или «ivan_petrov»: без экранирования `%` и `_`
    // выдача не соответствует запросу, а «%» вообще возвращает всё подряд.
    const { items } = await listOrdersForPanel(db, { query: '%' });

    expect(items).toHaveLength(0);
  });

  it('сортировка задаётся вызывающим и по умолчанию — свежие первыми', async () => {
    const newest = await listOrdersForPanel(db, { limit: 100 });
    const oldest = await listOrdersForPanel(db, { limit: 100, sort: 'oldest' });

    const newestTimes = newest.items.map((r) => r.createdAt.getTime());
    const oldestTimes = oldest.items.map((r) => r.createdAt.getTime());
    expect([...newestTimes].sort((x, y) => y - x)).toEqual(newestTimes);
    expect([...oldestTimes].sort((x, y) => x - y)).toEqual(oldestTimes);
  });

  it('усечение выборки НЕ молчаливое: hasMore говорит, что строки остались', async () => {
    const page = await listOrdersForPanel(db, { limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it('когда строк меньше потолка, hasMore ложь', async () => {
    const page = await listOrdersForPanel(db, { query: ordB1.shortId });

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });

  it('история заказа со 100+ событиями показывает СВЕЖИЕ, а не первые', async () => {
    const noisy = await createDraftOrder(db, {
      userId: panelUserA,
      status: 'draft',
      customServiceDescription: 'заказ с длинной историей',
      amountRub: 10000,
      originalAmount: 100,
      originalCurrency: 'USD',
    });
    for (let i = 0; i < 105; i++) {
      await appendOrderEvent(db, {
        orderId: noisy.id,
        eventType: `noise_${String(i).padStart(3, '0')}`,
        actorType: 'system',
      });
    }

    const detail = await getOrderDetailForPanel(db, noisy.shortId);
    const types = (detail?.events ?? []).map((e) => e.eventType);

    // Последнее событие обязано быть видно: ради него карточку и открывают.
    expect(types).toContain('noise_104');
    expect(types.length).toBeLessThanOrEqual(100);
    // И порядок остаётся хронологическим (сверху вниз).
    const times = (detail?.events ?? []).map((e) => e.createdAt.getTime());
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });

  it('сырое тело ответа провайдера в панель не тянется', async () => {
    const detail = await getOrderDetailForPanel(db, ordA1.shortId);

    // `payments.raw_payload` несёт контакты плательщика (антифрод-трек) — в
    // процессе панели ему делать нечего.
    expect(Object.keys(detail?.payments[0] ?? {})).not.toContain('rawPayload');
  });

  it('несуществующий номер заказа — null, а не исключение', async () => {
    expect(await getOrderDetailForPanel(db, 'ORD-НЕТУ')).toBeNull();
  });

  it('клиент только с сайта отдаётся без telegram_id — панель покажет это явно', async () => {
    const detail = await getOrderDetailForPanel(db, ordB1.shortId);

    expect(detail?.client).toMatchObject({ id: panelUserB, telegramId: null });
  });
});

describe('ручная выдача провалившегося заказа (тикет 06 админ-панели)', () => {
  /** Заказ реферала с начислением партнёру, который затем провалился. */
  async function makeFailedOrderWithReversedAccrual() {
    const partner = await makeUser();
    const buyer = await makeUser({ referredBy: partner.id, referredBySetAt: new Date() });
    const { order, payment } = await makeOrderWithPendingPayment({ userId: buyer.id });
    await claimPaymentSucceeded(db, { paymentId: payment.id });
    await insertCommissionAccruals(db, {
      sourceUserId: buyer.id,
      orderId: order.id,
      paymentId: payment.id,
      rows: [{ beneficiaryUserId: partner.id, level: 1, rateBps: 400, amountUsdCents: 200 }],
    });
    // Путь заказа до провала: оплачен → в работе → провалился (не хватило
    // баланса VCC-субаккаунта на выпуск карты — случай ORD-J6TBP).
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'paid' });
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'in_fulfillment' });
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'failed' });
    // Провал гасит комиссию компенсирующей строкой (как markOrderFailed).
    await reverseAccrualsForOrder(db, order.id);
    return { partner, buyer, order, payment };
  }

  it('переход failed → in_fulfillment разрешён и пишет событие с автором', async () => {
    const { order } = await makeFailedOrderWithReversedAccrual();

    const res = await transitionOrderDetailed(db, {
      orderId: order.id,
      toStatus: 'in_fulfillment',
      actorType: 'operator',
      actorId: '00000000-0000-4000-8000-0000000000ff',
      eventType: 'manual_fulfillment_started',
      payload: { comment: 'реквизиты отправили вручную' },
    });

    expect(res.transitioned).toBe(true);
    const events = await getOrderEventsByOrderId(db, order.id);
    const started = events.find((e) => e.eventType === 'manual_fulfillment_started');
    expect(started).toMatchObject({
      fromStatus: 'failed',
      toStatus: 'in_fulfillment',
      actorType: 'operator',
    });
    // Кто и почему — в журнале: он append-only и по нему считается выручка.
    expect(started?.payload).toMatchObject({ comment: 'реквизиты отправили вручную' });
    expect(started?.actorId).toBe('00000000-0000-4000-8000-0000000000ff');
  });

  it('прыжок сразу в completed по-прежнему запрещён', async () => {
    const { order } = await makeFailedOrderWithReversedAccrual();

    await expect(
      transitionOrderDetailed(db, { orderId: order.id, toStatus: 'completed' }),
    ).rejects.toBeInstanceOf(OrderTransitionError);
  });

  it('после двух шагов заказ снова считается состоявшимся', async () => {
    const { buyer, order } = await makeFailedOrderWithReversedAccrual();
    // До ручной выдачи заказ провалившийся: денег в итогах клиента нет.
    expect((await getClientDetailForPanel(db, buyer.id))?.totals.purchasedRubKopecks).toBe(0);
    expect(await hasPurchasedOrders(db, buyer.id)).toBe(false);

    await transitionOrderDetailed(db, {
      orderId: order.id,
      toStatus: 'in_fulfillment',
      actorType: 'operator',
      eventType: 'manual_fulfillment_started',
    });
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'completed' });

    const after = await getOrderById(db, order.id);
    expect(after?.status).toBe('completed');
    // «Считается состоявшимся» проверяем ПОТРЕБИТЕЛЯМИ набора статусов, а не
    // утверждением про саму константу: `toContain('completed')` зеленело бы и
    // при выборке, которая эту константу не читает.
    expect((await getClientDetailForPanel(db, buyer.id))?.totals.purchasedRubKopecks).toBe(
      order.amountRub,
    );
    expect(await hasPurchasedOrders(db, buyer.id)).toBe(true);
  });

  /**
   * Ответ на вопрос чеклиста тикета 06: реферальные начисления сами НЕ
   * восстанавливаются. Это не сломано тикетом — так устроен ledger, и вот
   * почему это приемлемо: расхождение НЕ теряется молча, его ловит зеркальная
   * сверка `findPurchasedOrdersWithReversedAccruals` и показывает владельцу.
   *
   * Восстановление ручное намеренно: дописать `accrued` автоматически нельзя
   * (упрётся в частичный UNIQUE), а компенсирующая строка «reversal reversal'а»
   * в append-only ledger'е — прямой путь к двойному начислению.
   */
  it('комиссия партнёра НЕ восстанавливается сама — но и не теряется молча', async () => {
    const { partner, order } = await makeFailedOrderWithReversedAccrual();
    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(0);

    await transitionOrderDetailed(db, {
      orderId: order.id,
      toStatus: 'in_fulfillment',
      actorType: 'operator',
      eventType: 'manual_fulfillment_started',
    });
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'completed' });

    // 1. Автодобор заказ НЕ подберёт: у него есть строки ledger'а (гашение),
    //    а `findOrdersMissingReferralAccruals` ищет заказы БЕЗ строк вовсе.
    const missing = await findOrdersMissingReferralAccruals(db, 50);
    expect(missing.map((m) => m.orderId)).not.toContain(order.id);

    // 2. Баланс партнёра остаётся нулевым — комиссия не вернулась.
    expect(await getReferralBalanceUsdCents(db, partner.id)).toBe(0);

    // 3. Но зеркальная сверка это ВИДИТ: заказ состоялся, а комиссия погашена.
    //    Значит владелец узнает и доначислит руками, а не обнаружит потерю от
    //    партнёра.
    const underpaid = await findPurchasedOrdersWithReversedAccruals(db, 50);
    expect(underpaid.map((u) => u.orderId)).toContain(order.id);
  });
});

describe('панель: карточка клиента (тикет 04)', () => {
  it('собирает контакты, заказы, карты и реферальные связи', async () => {
    const partner = await makeUser({ telegramId: 'tg-client-partner', displayName: 'Партнёр' });
    const client = await makeUser({
      telegramId: 'tg-client-main',
      displayName: 'Клиент',
      email: 'client@example.com',
      phone: '+79990001122',
      phoneSource: 'telegram',
      referredBy: partner.id,
      referredBySetAt: new Date(),
    });
    const invited = await makeUser({
      telegramId: 'tg-client-invited',
      displayName: 'Приглашённый',
      referredBy: client.id,
      referredBySetAt: new Date(),
    });
    const order = await createDraftOrder(db, {
      userId: client.id,
      status: 'completed',
      customServiceDescription: 'Netflix',
      amountRub: 99900,
      originalAmount: 1200,
      originalCurrency: 'USD',
    });
    await db.insert(schema.cards).values({
      userId: client.id,
      providerCardId: `client-card-${++seq}`,
      panMasked: '555555******7777',
      balanceUsdCents: 300,
    });

    const detail = await getClientDetailForPanel(db, client.id);

    expect(detail?.client).toMatchObject({
      telegramId: 'tg-client-main',
      email: 'client@example.com',
      phone: '+79990001122',
      phoneSource: 'telegram',
    });
    expect(detail?.orders.map((o) => o.shortId)).toContain(order.shortId);
    expect(detail?.orders[0]).toMatchObject({ serviceName: 'Netflix', amountRubKopecks: 99900 });
    expect(detail?.cards[0]).toMatchObject({ panMasked: '555555******7777' });
    expect(detail?.referredBy).toMatchObject({ id: partner.id, displayName: 'Партнёр' });
    expect(detail?.referrals.map((r) => r.id)).toContain(invited.id);
  });

  it('клиент только с сайта отдаётся без telegram_id — панель скажет это прямо', async () => {
    const webOnly = await makeUser({
      telegramId: null,
      webSessionId: `web-client-${++seq}`,
      displayName: null,
    });

    const detail = await getClientDetailForPanel(db, webOnly.id);

    expect(detail?.client.telegramId).toBeNull();
    // Наружу уходит ФЛАГ, а не сам `web_session_id`: его значение — содержимое
    // httpOnly-cookie клиента, то есть живой креденшл (им можно выдать себя за
    // клиента). Панели достаточно знать, что человек пришёл с сайта.
    expect(detail?.client.hasWebSession).toBe(true);
    expect(JSON.stringify(detail)).not.toContain(webOnly.webSessionId);
  });

  it('клиент без заказов, карт и связей — пустые списки, а не ошибка', async () => {
    const lonely = await makeUser({ telegramId: `tg-lonely-${++seq}` });

    const detail = await getClientDetailForPanel(db, lonely.id);

    expect(detail).not.toBeNull();
    expect(detail?.orders).toEqual([]);
    expect(detail?.cards).toEqual([]);
    expect(detail?.referredBy).toBeNull();
    expect(detail?.referrals).toEqual([]);
  });

  it('несуществующий клиент — null, а не исключение', async () => {
    expect(
      await getClientDetailForPanel(db, '00000000-0000-4000-8000-00000000dead'),
    ).toBeNull();
  });

  it('карта клиента отдаётся только маскированной', async () => {
    const client = await makeUser({ telegramId: `tg-card-client-${++seq}` });
    await db.insert(schema.cards).values({
      userId: client.id,
      providerCardId: `client-card-${++seq}`,
      panMasked: '400000******1111',
      balanceUsdCents: 0,
    });

    const detail = await getClientDetailForPanel(db, client.id);

    expect(Object.keys(detail?.cards[0] ?? {}).sort()).toEqual([
      'balanceUsdCents',
      'createdAt',
      'id',
      'panMasked',
      'status',
    ]);
  });

  it('итоги считаются в БАЗЕ и не занижаются срезом списка', async () => {
    // Смысл всей затеи виден только за потолком выборки: список режется, а
    // деньги — нет. Складывать видимые строки значило бы показывать владельцу
    // заниженную сумму по самому ценному клиенту и ровно столько заказов,
    // сколько влезло на экран.
    const client = await makeUser({ telegramId: `tg-client-many-${++seq}` });
    const total = PANEL_MAX_ROWS + 5;
    for (let i = 0; i < total; i++) {
      await createDraftOrder(db, {
        userId: client.id,
        status: 'completed',
        customServiceDescription: `bulk order ${i}`,
        amountRub: 10_000,
        originalAmount: 100,
        originalCurrency: 'USD',
      });
    }

    const detail = await getClientDetailForPanel(db, client.id);

    expect(detail?.orders.length).toBe(PANEL_MAX_ROWS);
    expect(detail?.totals.ordersCount).toBe(total);
    expect(detail?.totals.purchasedRubKopecks).toBe(total * 10_000);
  });

  it('карт у клиента считается столько, сколько их есть, а не сколько показано', async () => {
    const client = await makeUser({ telegramId: `tg-client-cards-${++seq}` });
    for (let i = 0; i < 3; i++) {
      await db.insert(schema.cards).values({
        userId: client.id,
        providerCardId: `count-card-${++seq}`,
        panMasked: '400000******2222',
        balanceUsdCents: 0,
      });
    }

    const detail = await getClientDetailForPanel(db, client.id);

    expect(detail?.totals.cardsCount).toBe(3);
  });

  it('последний живой IP клиента в панель не отдаётся', async () => {
    const client = await makeUser({ telegramId: `tg-ip-client-${++seq}` });
    await touchUserLastSeenIp(db, { userId: client.id, ip: '203.0.113.77' });

    const detail = await getClientDetailForPanel(db, client.id);

    // IP нужен антифрод-треку при выставлении счёта; на экране это лишняя PII,
    // которую менеджеру не с чем сопоставить.
    expect(JSON.stringify(detail)).not.toContain('203.0.113.77');
  });
});

describe('панель: партнёры и выплаты (тикет 12)', () => {
  /**
   * ⚠️ Ставка начисления и ставка профиля здесь РАЗНЫЕ намеренно. Положи в обе
   * строки одно число — и тест «ставка берётся только из `locked_rate_l1_bps`»
   * пройдёт даже если выборка возьмёт её из `referral_accruals.rate_bps`, то
   * есть ровно из второго места, которого по решению владельца быть не должно.
   */
  async function makePartnerWithAccrual(
    over: {
      accrualRateBps?: number;
      lockedRateL1Bps?: number;
      suspended?: boolean;
      withProfile?: boolean;
    } = {},
  ) {
    const partner = await makeUser({ telegramId: `tg-partner-${++seq}`, displayName: 'Партнёр' });
    const buyer = await makeUser({ referredBy: partner.id, referredBySetAt: new Date() });
    const { order, payment } = await makeOrderWithPendingPayment({ userId: buyer.id });
    await claimPaymentSucceeded(db, { paymentId: payment.id });
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'paid' });
    await insertCommissionAccruals(db, {
      sourceUserId: buyer.id,
      orderId: order.id,
      paymentId: payment.id,
      rows: [
        {
          beneficiaryUserId: partner.id,
          level: 1,
          rateBps: over.accrualRateBps ?? 400,
          amountUsdCents: 500,
        },
      ],
    });
    if (over.withProfile ?? true) {
      await db.insert(schema.referralPartners).values({
        userId: partner.id,
        lockedRateL1Bps: over.lockedRateL1Bps ?? 550,
        suspended: over.suspended ?? false,
      });
    }
    return { partner, buyer, order };
  }

  it('партнёр виден с начисленным, балансом и ЗАФИКСИРОВАННОЙ ставкой', async () => {
    const { partner } = await makePartnerWithAccrual({ accrualRateBps: 400, lockedRateL1Bps: 550 });

    const { items } = await listReferralPartnersForPanel(db, { limit: 100 });
    const row = items.find((p) => p.userId === partner.id);

    expect(row?.accruedUsdCents).toBe(500);
    expect(row?.balanceUsdCents).toBe(500);
    expect(row?.referralsCount).toBe(1);
    // Ставка — ТОЛЬКО из `locked_rate_l1_bps`, единственного источника по
    // решению владельца от 11 августа.
    expect(row?.lockedRateL1Bps).toBe(550);
  });

  it('отменённое начисление вычитается, а не показывается как заработок', async () => {
    const { partner, order } = await makePartnerWithAccrual();
    // Отмена привязана к ПРОВАЛУ заказа: гасить комиссию по живому заказу
    // нельзя, и выборка обязана считать ровно то же, что ledger.
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'in_fulfillment' });
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'failed' });
    await reverseAccrualsForOrder(db, order.id);

    const { items } = await listReferralPartnersForPanel(db, { limit: 100 });

    expect(items.find((p) => p.userId === partner.id)?.accruedUsdCents).toBe(0);
  });

  it('заявка на вывод уменьшает баланс до решения по ней', async () => {
    const { partner } = await makePartnerWithAccrual();
    await createReferralPayout(db, { userId: partner.id, amountUsdCents: 300 });

    const { items } = await listReferralPartnersForPanel(db, { limit: 100 });

    expect(items.find((p) => p.userId === partner.id)?.balanceUsdCents).toBe(200);
  });

  it('ОТКЛОНЁННАЯ заявка возвращает деньги в баланс сама', async () => {
    // Компенсирующая строка в append-only ledger'е тут не нужна и была бы
    // вредна: формула баланса просто не считает отклонённые заявки.
    const { partner } = await makePartnerWithAccrual();
    const created = await createReferralPayout(db, { userId: partner.id, amountUsdCents: 300 });
    if (!created.ok) throw new Error('заявка не создалась');

    await transitionReferralPayout(db, {
      payoutId: created.payoutId,
      from: 'requested',
      to: 'rejected',
    });

    const { items } = await listReferralPartnersForPanel(db, { limit: 100 });
    expect(items.find((p) => p.userId === partner.id)?.balanceUsdCents).toBe(500);
  });

  it('приглашённые партнёра видны с их деньгами, и НЕсостоявшийся заказ в сумму не идёт', async () => {
    const { partner, buyer } = await makePartnerWithAccrual();
    // Второй заказ того же клиента, который деньгами не стал: без него фильтр
    // `PURCHASED_STATUSES_SQL` тождественен «все заказы» и ничего не проверяет.
    const failed = await makeOrderWithPendingPayment({ userId: buyer.id });
    await transitionOrderDetailed(db, { orderId: failed.order.id, toStatus: 'failed' });

    const { items } = await listPartnerReferralsForPanel(db, partner.id, { limit: 100 });
    const row = items.find((r) => r.userId === buyer.id);

    // Заказов у клиента два, но «принёс» — только оплаченный.
    expect(row?.ordersCount).toBe(2);
    // Заказ оплачен (`paid` входит в PURCHASED_ORDER_STATUSES).
    expect(row?.purchasedRubKopecks).toBe(50_000);
  });

  it('партнёр без профиля виден сразу, а не с 1-го числа следующего месяца', async () => {
    // Строку в `referral_partners` создаёт ТОЛЬКО месячный роллап. Возьми
    // список из неё — и партнёр, заработавший комиссию 5 августа, до 1 сентября
    // отсутствует на экране, который вдобавок пишет «Партнёров пока нет».
    const { partner } = await makePartnerWithAccrual({ withProfile: false });

    const { items } = await listReferralPartnersForPanel(db, { limit: 100 });
    const row = items.find((p) => p.userId === partner.id);

    expect(row?.accruedUsdCents).toBe(500);
    expect(row?.hasProfile).toBe(false);
    // Ставка показывается дефолтная — та же, по которой считает начисление.
    expect(row?.lockedRateL1Bps).toBe(DEFAULT_REFERRAL_RATE_L1_BPS);
  });

  it('блокировка партнёра видна в списке и в его заявке', async () => {
    // Гейт «заблокированному не выплачиваем» стоит в операции, но узнать о
    // блокировке владелец должен ДО нажатия — иначе кнопка врёт.
    const { partner } = await makePartnerWithAccrual({ suspended: true });
    const created = await createReferralPayout(db, { userId: partner.id, amountUsdCents: 100 });
    if (!created.ok) throw new Error('заявка не создалась');

    const partners = await listReferralPartnersForPanel(db, { limit: 100 });
    const payouts = await listReferralPayoutsForPanel(db, { limit: 100 });

    expect(partners.items.find((p) => p.userId === partner.id)?.suspended).toBe(true);
    expect(payouts.items.find((p) => p.payoutId === created.payoutId)?.suspended).toBe(true);
  });

  it('заявка в списке выплат несёт партнёра, сумму и его баланс', async () => {
    const { partner } = await makePartnerWithAccrual();
    const created = await createReferralPayout(db, { userId: partner.id, amountUsdCents: 200 });
    if (!created.ok) throw new Error('заявка не создалась');

    const { items } = await listReferralPayoutsForPanel(db, { limit: 100 });
    const row = items.find((p) => p.payoutId === created.payoutId);

    expect(row?.amountUsdCents).toBe(200);
    expect(row?.status).toBe('requested');
    expect(row?.displayName).toBe('Партнёр');
    // Баланс СЕЙЧАС — чтобы видеть, чем заявка обеспечена.
    expect(row?.balanceUsdCents).toBe(300);
  });

  it('реквизиты выплаты наружу НЕ отдаются', async () => {
    // В `destination` лежат маскированный номер карты или адрес кошелька, и
    // для решения «выплатить или отклонить» они не нужны.
    const { partner } = await makePartnerWithAccrual();
    const created = await createReferralPayout(db, {
      userId: partner.id,
      amountUsdCents: 100,
      method: 'crypto_usdt',
      destination: {
        method: 'crypto_usdt',
        network: 'trc20',
        address: 'TXYZ000000000000000000000000000000',
      },
    });
    if (!created.ok) throw new Error('заявка не создалась');

    const { items } = await listReferralPayoutsForPanel(db, { limit: 100 });

    expect(JSON.stringify(items)).not.toContain('TXYZ');
  });

  it('усечение списка партнёров не молчит', async () => {
    await makePartnerWithAccrual();
    await makePartnerWithAccrual();

    const page = await listReferralPartnersForPanel(db, { limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it('усечение списка приглашённых и списка заявок тоже не молчит', async () => {
    const { partner, buyer } = await makePartnerWithAccrual();
    // Второй приглашённый с заказом — иначе усекать нечего.
    const second = await makeUser({ referredBy: partner.id, referredBySetAt: new Date() });
    await makeOrderWithPendingPayment({ userId: second.id });
    await createReferralPayout(db, { userId: partner.id, amountUsdCents: 100 });

    const referrals = await listPartnerReferralsForPanel(db, partner.id, { limit: 1 });
    const payouts = await listReferralPayoutsForPanel(db, { limit: 1 });

    expect(referrals.items).toHaveLength(1);
    expect(referrals.hasMore).toBe(true);
    expect(payouts.items).toHaveLength(1);
    expect(payouts.hasMore).toBe(true);
    // Оба списка помещаются целиком — «есть ещё» обязано быть ложью, иначе
    // экран вечно пишет «показаны не все» и предупреждение перестают читать.
    expect((await listPartnerReferralsForPanel(db, partner.id, { limit: 100 })).hasMore).toBe(false);
    expect(buyer.id).toBeTruthy();
  });

  it('по умолчанию экран заявок показывает открытые, а закрытые — по запросу', async () => {
    // Закрытые заявки копятся навсегда и вытеснили бы живые за потолок выборки.
    const { partner } = await makePartnerWithAccrual();
    const open = await createReferralPayout(db, { userId: partner.id, amountUsdCents: 100 });
    if (!open.ok) throw new Error('заявка не создалась');
    await transitionReferralPayout(db, { payoutId: open.payoutId, from: 'requested', to: 'rejected' });
    const second = await createReferralPayout(db, { userId: partner.id, amountUsdCents: 150 });
    if (!second.ok) throw new Error('вторая заявка не создалась');

    const onlyOpen = await listReferralPayoutsForPanel(db, { limit: 100, onlyOpen: true });
    const all = await listReferralPayoutsForPanel(db, { limit: 100 });

    const mine = (page: { items: { payoutId: string }[] }) =>
      page.items.map((p) => p.payoutId).filter((id) => id === open.payoutId || id === second.payoutId);
    expect(mine(onlyOpen)).toEqual([second.payoutId]);
    expect(mine(all).sort()).toEqual([open.payoutId, second.payoutId].sort());
  });

  it('заявка в processing разрешается из панели, а не только SQL на проде', async () => {
    // «Выплачено» — два перехода вне одной транзакции: упавший между ними
    // процесс оставляет заявку здесь, и её сумма продолжает вычитаться из
    // баланса. Машина статусов доводить такую заявку разрешает.
    const { partner } = await makePartnerWithAccrual();
    const created = await createReferralPayout(db, { userId: partner.id, amountUsdCents: 100 });
    if (!created.ok) throw new Error('заявка не создалась');
    await transitionReferralPayout(db, {
      payoutId: created.payoutId,
      from: 'requested',
      to: 'processing',
    });

    const stuck = await findReferralPayoutForPanel(db, created.payoutId);
    const finished = await transitionReferralPayout(db, {
      payoutId: created.payoutId,
      from: 'processing',
      to: 'paid',
    });

    expect(stuck?.status).toBe('processing');
    expect(finished.applied).toBe(true);
    expect(finished.status).toBe('paid');
  });

  it('несостоявшийся переход возвращает ФАКТИЧЕСКИЙ статус, а не запрошенный', async () => {
    // Вернуть `from` — соврать о состоянии денег: панель показала бы «заявка
    // всё ещё ждёт решения» там, где её уже кто-то отклонил.
    const { partner } = await makePartnerWithAccrual();
    const created = await createReferralPayout(db, { userId: partner.id, amountUsdCents: 100 });
    if (!created.ok) throw new Error('заявка не создалась');
    await transitionReferralPayout(db, {
      payoutId: created.payoutId,
      from: 'requested',
      to: 'rejected',
    });

    const late = await transitionReferralPayout(db, {
      payoutId: created.payoutId,
      from: 'requested',
      to: 'processing',
    });

    expect(late.applied).toBe(false);
    expect(late.status).toBe('rejected');
  });
});

describe('панель: поддержка (тикет 10)', () => {
  // Сотрудники заводятся один раз на блок: `messages.staff_id` — настоящий FK,
  // и выдуманный uuid отвергнет база.
  let SUPPORT_STAFF_ID = '';
  let OTHER_STAFF_ID = '';

  beforeAll(async () => {
    const first = await upsertStaffByTelegramId(db, {
      telegramId: `staff-support-${++seq}`,
      email: `support-${seq}@example.com`,
      displayName: 'Менеджер поддержки',
      role: 'operator',
    });
    const second = await upsertStaffByTelegramId(db, {
      telegramId: `staff-support-2-${++seq}`,
      email: `support2-${seq}@example.com`,
      displayName: 'Второй менеджер',
      role: 'operator',
    });
    SUPPORT_STAFF_ID = first.id;
    OTHER_STAFF_ID = second.id;
  });

  async function makeSupportRequest(
    userId: string,
    opts: { delivered?: boolean; text?: string } = {},
  ) {
    const conversation = await createConversation(db, { userId, channel: 'telegram' });
    await appendMessage(db, {
      conversationId: conversation.id,
      role: 'user',
      content: opts.text ?? 'не проходит оплата, помогите',
    });
    await appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Передали в поддержку',
      meta: { source: 'support', support_request: true, support_delivered: opts.delivered ?? true },
    });
    return conversation;
  }

  it('обращение попадает в список, ответа пока нет', async () => {
    const user = await makeUser({ telegramId: `tg-support-${++seq}`, displayName: 'Клиент' });
    const conversation = await makeSupportRequest(user.id);

    const { items } = await listSupportRequestsForPanel(db, { userId: user.id });
    const row = items.find((r) => r.conversationId === conversation.id);

    expect(row?.client.displayName).toBe('Клиент');
    expect(row?.lastRequestAt).toBeInstanceOf(Date);
    expect(row?.lastOperatorReplyAt).toBeNull();
    expect(row?.lastRequestDelivered).toBe(true);
  });

  it('начатое обращение (бот только спросил) обращением НЕ считается', async () => {
    // У приглашения «опиши проблему» тот же `source: 'support'`, что и у
    // поданного обращения. Без явной отметки экран показывал бы как обращение
    // каждое нажатие кнопки.
    const user = await makeUser({ telegramId: `tg-support-ask-${++seq}` });
    const conversation = await createConversation(db, { userId: user.id, channel: 'telegram' });
    await appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Опиши проблему',
      meta: { source: 'support', awaiting_support_message: true },
    });

    const { items } = await listSupportRequestsForPanel(db, { userId: user.id });

    expect(items).toHaveLength(0);
  });

  it('недоставленное оператору обращение помечается', async () => {
    // Не доставили — это наша авария конфигурации, и она обязана быть видна:
    // клиент считает, что написал, а обращение никуда не ушло.
    const user = await makeUser({ telegramId: `tg-support-fail-${++seq}` });
    const conversation = await makeSupportRequest(user.id, { delivered: false });

    const { items } = await listSupportRequestsForPanel(db, { userId: user.id });

    expect(items.find((r) => r.conversationId === conversation.id)?.lastRequestDelivered).toBe(
      false,
    );
  });

  it('ответ оператора виден в списке', async () => {
    const user = await makeUser({ telegramId: `tg-support-answered-${++seq}` });
    const conversation = await makeSupportRequest(user.id);
    const { id } = await appendMessage(db, {
      conversationId: conversation.id,
      role: 'operator',
      content: 'Разобрались, счёт перевыставлен',
      staffId: SUPPORT_STAFF_ID,
    });
    await db
      .update(schema.messages)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.messages.id, id));

    const { items } = await listSupportRequestsForPanel(db, { userId: user.id });

    expect(
      items.find((r) => r.conversationId === conversation.id)?.lastOperatorReplyAt,
    ).toBeInstanceOf(Date);
  });

  it('старый ответ НЕ закрывает новое обращение того же клиента', async () => {
    // Разговор один на клиента: «когда-то отвечали» означало бы, что повторное
    // обращение постоянного клиента навсегда числится отвеченным и не попадает
    // в счётчик «без ответа» на рабочем столе.
    const user = await makeUser({ telegramId: `tg-support-again-${++seq}` });
    const conversation = await makeSupportRequest(user.id);
    const reply = await appendMessage(db, {
      conversationId: conversation.id,
      role: 'operator',
      content: 'ответили на первое',
      staffId: SUPPORT_STAFF_ID,
    });
    await db
      .update(schema.messages)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.messages.id, reply.id));

    const second = await appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Передали в поддержку',
      meta: { source: 'support', support_request: true, support_delivered: true },
    });
    await db
      .update(schema.messages)
      .set({ createdAt: new Date(Date.now() + 120_000) })
      .where(eq(schema.messages.id, second.id));

    const { items } = await listSupportRequestsForPanel(db, { userId: user.id });

    expect(items.find((r) => r.conversationId === conversation.id)?.lastOperatorReplyAt).toBeNull();
  });

  it('свежие обращения сверху, отметка доставки — от ПОСЛЕДНЕГО', async () => {
    // Все проверки этого блока раньше делались на выборке из одной строки, где
    // и порядок, и «последний из нескольких» выполняются тождественно (находка
    // ревью). Здесь у клиента ДВА обращения и два разговора.
    const user = await makeUser({ telegramId: `tg-support-order-${++seq}` });
    const older = await makeSupportRequest(user.id, { delivered: false, text: 'первое' });
    const newer = await makeSupportRequest(user.id, { delivered: true, text: 'второе' });
    // Возраст задаём явно: несколько INSERT'ов подряд ложатся в одну отметку.
    await db
      .update(schema.messages)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(schema.messages.conversationId, older.id));

    const { items } = await listSupportRequestsForPanel(db, { userId: user.id });

    expect(items.map((i) => i.conversationId)).toEqual([newer.id, older.id]);
    // У каждого разговора — СВОЙ исход доставки, а не исход соседа.
    expect(items[0]?.lastRequestDelivered).toBe(true);
    expect(items[1]?.lastRequestDelivered).toBe(false);
  });

  it('повторное обращение в ТОМ ЖЕ разговоре берёт свежую отметку', async () => {
    // У клиента, написавшего дважды, экран обязан показывать исход ПОСЛЕДНЕГО
    // обращения: старый успех рядом со свежим провалом читается как «дошло».
    const user = await makeUser({ telegramId: `tg-support-repeat-${++seq}` });
    const conversation = await makeSupportRequest(user.id, { delivered: true });
    const { id } = await appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Передали в поддержку',
      meta: { source: 'support', support_request: true, support_delivered: false },
    });
    await db
      .update(schema.messages)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.messages.id, id));

    const { items } = await listSupportRequestsForPanel(db, { userId: user.id });

    expect(items.find((i) => i.conversationId === conversation.id)?.lastRequestDelivered).toBe(
      false,
    );
  });

  it('усечение списка обращений не молчит — и не кричит без повода', async () => {
    const user = await makeUser({ telegramId: `tg-support-page-${++seq}` });
    await makeSupportRequest(user.id);
    await makeSupportRequest(user.id);

    const page = await listSupportRequestsForPanel(db, { userId: user.id, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);

    const full = await listSupportRequestsForPanel(db, { userId: user.id, limit: 5 });
    expect(full.items).toHaveLength(2);
    expect(full.hasMore).toBe(false);
  });

  it('«кто ведёт» показывает имя сотрудника, а не прочерк', async () => {
    const user = await makeUser({ telegramId: `tg-support-owner-${++seq}` });
    const conversation = await makeSupportRequest(user.id);
    await claimSupportConversation(db, {
      conversationId: conversation.id,
      staffId: SUPPORT_STAFF_ID,
    });

    const { items } = await listSupportRequestsForPanel(db, { userId: user.id });

    expect(items.find((i) => i.conversationId === conversation.id)?.assignedOperatorName).toBe(
      'Менеджер поддержки',
    );
  });

  it('обращения ДО появления отметки не выдаются за недоставленные', async () => {
    // У старых строк meta без ключа: «не знаем» — не повод писать напраслину.
    const user = await makeUser({ telegramId: `tg-support-legacy-${++seq}` });
    const conversation = await createConversation(db, { userId: user.id, channel: 'telegram' });
    await appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Передали в поддержку',
      meta: { source: 'support', support_request: true },
    });

    const { items } = await listSupportRequestsForPanel(db, { userId: user.id });

    expect(items.find((i) => i.conversationId === conversation.id)?.lastRequestDelivered).toBe(
      true,
    );
  });

  it('неотвеченные обращения считаются по ВСЕЙ базе', async () => {
    const before = await countUnansweredSupportRequests(db);
    const user = await makeUser({ telegramId: `tg-support-count-${++seq}` });
    const conversation = await makeSupportRequest(user.id);

    expect(await countUnansweredSupportRequests(db)).toBe(before + 1);

    const { id } = await appendMessage(db, {
      conversationId: conversation.id,
      role: 'operator',
      content: 'ответили',
      staffId: SUPPORT_STAFF_ID,
    });
    // Ответ должен быть ПОЗЖЕ обращения; соседние INSERT'ы ложатся в одну
    // отметку `now()`, и «позже» переставало быть определено.
    await db
      .update(schema.messages)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.messages.id, id));

    // Ответ снимает обращение со счётчика — иначе цифра на столе не спадает
    // никогда и её перестают читать.
    expect(await countUnansweredSupportRequests(db)).toBe(before);
  });

  it('лента отдаёт КОНЕЦ переписки и говорит про обрыв', async () => {
    const user = await makeUser({ telegramId: `tg-support-thread-${++seq}` });
    const conversation = await makeSupportRequest(user.id);
    for (let i = 0; i < 5; i++) {
      const { id } = await appendMessage(db, {
        conversationId: conversation.id,
        role: 'user',
        content: `сообщение ${i}`,
      });
      // Время задаём явно: несколько INSERT'ов подряд ложатся в одну отметку
      // `now()`, и «последние три» переставали быть определены — тест зеленел
      // бы от случая, а не от правила.
      await db
        .update(schema.messages)
        .set({ createdAt: new Date(Date.now() + (i + 1) * 1000) })
        .where(eq(schema.messages.id, id));
    }

    const thread = await getSupportThreadForPanel(db, conversation.id, 3);

    expect(thread?.messages).toHaveLength(3);
    // Читают сверху вниз, а показывать надо последние: порядок хронологический.
    expect(thread?.messages.at(-1)?.content).toBe('сообщение 4');
    expect(thread?.hasMore).toBe(true);
  });

  it('короткая переписка про обрыв не сочиняет', async () => {
    const user = await makeUser({ telegramId: `tg-support-short-${++seq}` });
    const conversation = await makeSupportRequest(user.id);

    const thread = await getSupportThreadForPanel(db, conversation.id, 50);

    expect(thread?.hasMore).toBe(false);
    expect(thread?.messages).toHaveLength(2);
  });

  it('несуществующий диалог — null, а не пустая лента', async () => {
    expect(
      await getSupportThreadForPanel(db, '00000000-0000-4000-8000-00000000dead'),
    ).toBeNull();
  });

  it('подключение закрепляет диалог, второй сотрудник получает отказ', async () => {
    const user = await makeUser({ telegramId: `tg-support-claim-${++seq}` });
    const conversation = await makeSupportRequest(user.id);

    expect(
      await claimSupportConversation(db, {
        conversationId: conversation.id,
        staffId: SUPPORT_STAFF_ID,
      }),
    ).toBe('claimed');
    // Двое, отвечающие одному клиенту, — то, ради чего кнопка и существует.
    expect(
      await claimSupportConversation(db, {
        conversationId: conversation.id,
        staffId: OTHER_STAFF_ID,
      }),
    ).toBe('taken');
    // Повторное нажатие ТЕМ ЖЕ сотрудником отказом не является.
    expect(
      await claimSupportConversation(db, {
        conversationId: conversation.id,
        staffId: SUPPORT_STAFF_ID,
      }),
    ).toBe('claimed');
    // Несуществующий диалог — это НЕ «занято коллегой»: одинаковый ответ
    // отправлял бы менеджера искать несуществующего человека.
    expect(
      await claimSupportConversation(db, {
        conversationId: '00000000-0000-4000-8000-00000000dead',
        staffId: SUPPORT_STAFF_ID,
      }),
    ).toBe('not_found');

    const thread = await getSupportThreadForPanel(db, conversation.id);
    expect(thread?.handoffMode).toBe('operator');
    expect(thread?.assignedOperatorId).toBe(SUPPORT_STAFF_ID);
  });
});

describe('панель: недожатые заказы (тикет 07)', () => {
  /** Заказ с живым счётом и ссылкой на оплату в снимке инвойса. */
  async function makeOrderWithLiveInvoice(userId: string, paymentUrl: string | null) {
    const order = await createDraftOrder(db, {
      userId,
      status: 'pending_payment',
      customServiceDescription: 'pending order',
      amountRub: 50_000,
      originalAmount: 500,
      originalCurrency: 'USD',
    });
    const { payment } = await upsertPaymentByProviderRef(db, {
      orderId: order.id,
      provider: 'freekassa',
      providerRef: `pending-${++seq}`,
      amountRub: 50_000,
      rawPayload: paymentUrl
        ? { invoice: { id: 'inv-1', paymentLink: paymentUrl } }
        : { invoice: { id: 'inv-1' } },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return { order, payment };
  }

  it('заказ со счётом отдаёт ссылку на оплату из снимка инвойса', async () => {
    const user = await makeUser({ telegramId: `tg-pending-${++seq}` });
    const { order } = await makeOrderWithLiveInvoice(user.id, 'https://pay.example/inv-1');

    const { items } = await listPendingOrdersForPanel(db, { userId: user.id });
    const row = items.find((r) => r.orderId === order.id);

    // Отдельной колонки под ссылку нет: она лежит в снимке инвойса, и
    // доставать её обязано ОДНО место — иначе список и операция разъедутся.
    expect(row?.invoice?.paymentUrl).toBe('https://pay.example/inv-1');
    expect(row?.client.telegramId).toBe(user.telegramId);
  });

  it('черновик без счёта в списке ЕСТЬ, но счёта у него нет', async () => {
    // 97 из 138 просроченных заказов до счёта не дошли — прятать эту половину
    // потери нельзя, хотя напоминать по ней нечем.
    const user = await makeUser({ telegramId: `tg-pending-draft-${++seq}` });
    const order = await createDraftOrder(db, {
      userId: user.id,
      status: 'ready_for_payment',
      customServiceDescription: 'draft order',
      amountRub: 30_000,
      originalAmount: 300,
      originalCurrency: 'USD',
    });

    const { items } = await listPendingOrdersForPanel(db, { userId: user.id });
    const row = items.find((r) => r.orderId === order.id);

    expect(row?.status).toBe('ready_for_payment');
    expect(row?.invoice).toBeNull();
  });

  it('терминальный счёт живым не считается', async () => {
    const user = await makeUser({ telegramId: `tg-pending-dead-${++seq}` });
    const { order, payment } = await makeOrderWithLiveInvoice(user.id, 'https://pay.example/dead');
    await claimPaymentTerminal(db, payment.id);

    const { items } = await listPendingOrdersForPanel(db, { userId: user.id });

    expect(items.find((r) => r.orderId === order.id)?.invoice).toBeNull();
  });

  it('оплаченный заказ с экрана уходит', async () => {
    const user = await makeUser({ telegramId: `tg-pending-paid-${++seq}` });
    const { order, payment } = await makeOrderWithLiveInvoice(user.id, 'https://pay.example/paid');
    await claimPaymentSucceeded(db, { paymentId: payment.id });
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'paid' });

    // Фильтр по клиенту: без него собственный заказ теста однажды окажется за
    // потолком страницы, и отрицательный ассерт замолчит, ничего не покрасив.
    const { items } = await listPendingOrdersForPanel(db, { userId: user.id });

    expect(items).toHaveLength(0);
  });

  it('когда напоминали — читается из журнала заказа', async () => {
    const user = await makeUser({ telegramId: `tg-pending-remind-${++seq}` });
    const { order } = await makeOrderWithLiveInvoice(user.id, 'https://pay.example/remind');

    const before = await listPendingOrdersForPanel(db, { userId: user.id });
    expect(before.items.find((r) => r.orderId === order.id)?.lastRemindedAt).toBeNull();

    await appendOrderEvent(db, {
      orderId: order.id,
      eventType: PAYMENT_REMINDER_SENT_EVENT,
      actorType: 'operator',
    });

    const after = await listPendingOrdersForPanel(db, { userId: user.id });
    expect(after.items.find((r) => r.orderId === order.id)?.lastRemindedAt).toBeInstanceOf(Date);
  });

  it('СОРВАННАЯ доставка напоминания видна отдельно от отправленной', async () => {
    // Окно суток занимается ДО отправки и вернуть его нечем (журнал
    // append-only). Без отдельного признака экран показывал бы «напоминали в
    // 14:20» там, где клиент не получил ничего: менеджер считает заказ
    // обработанным и сутки не может повторить.
    const user = await makeUser({ telegramId: `tg-pending-failed-${++seq}` });
    const { order } = await makeOrderWithLiveInvoice(user.id, 'https://pay.example/failed');

    await appendOrderEvent(db, {
      orderId: order.id,
      eventType: PAYMENT_REMINDER_SENT_EVENT,
      actorType: 'operator',
    });
    await appendOrderEvent(db, {
      orderId: order.id,
      eventType: PAYMENT_REMINDER_FAILED_EVENT,
      actorType: 'operator',
    });

    const { items } = await listPendingOrdersForPanel(db, { userId: user.id });
    const row = items.find((r) => r.orderId === order.id);

    expect(row?.lastRemindedAt).toBeInstanceOf(Date);
    expect(row?.lastRemindFailedAt).toBeInstanceOf(Date);
  });

  it('усечение списка не молчит — и не кричит, когда всё влезло', async () => {
    // ⚠️ Обе стороны пиннятся НА ИЗОЛИРОВАННОЙ выборке. На общей базе файла
    // (десятки недожатых заказов) `hasMore` истинно тождественно: мутация
    // «всегда true» проходила бы весь прогон, а экран врал бы «показаны не все»
    // каждый день (находка ревью).
    const user = await makeUser({ telegramId: `tg-pending-page-${++seq}` });
    await makeOrderWithLiveInvoice(user.id, 'https://pay.example/a');
    await makeOrderWithLiveInvoice(user.id, 'https://pay.example/b');

    const page = await listPendingOrdersForPanel(db, { userId: user.id, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);

    const full = await listPendingOrdersForPanel(db, { userId: user.id, limit: 5 });
    expect(full.items).toHaveLength(2);
    expect(full.hasMore).toBe(false);

    // Старые сверху: возраст и есть причина, по которой экран нужен.
    const times = full.items.map((i) => i.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('итоги считаются по ВСЕМ недожатым, а не по видимым пяти', async () => {
    const before = await countPendingOrdersForPanel(db);
    const user = await makeUser({ telegramId: `tg-pending-totals-${++seq}` });
    await makeOrderWithLiveInvoice(user.id, 'https://pay.example/t1');
    await makeOrderWithLiveInvoice(user.id, 'https://pay.example/t2');

    const after = await countPendingOrdersForPanel(db);

    // Рабочий стол показывает пять строк, а число и деньги обязан называть
    // настоящие: «5+ на 50 000 ₽» при сорока заказах занижает ровно то, ради
    // чего блок существует.
    expect(after.count).toBe(before.count + 2);
    expect(after.sumKopecks).toBe(before.sumKopecks + 100_000);
  });

  it('дедуп напоминания атомарен: второй одновременный claim не проходит', async () => {
    const user = await makeUser({ telegramId: `tg-pending-claim-${++seq}` });
    const { order } = await makeOrderWithLiveInvoice(user.id, 'https://pay.example/claim');

    // Две вкладки жмут «Напомнить» одновременно. Схема «прочитали отметку →
    // отправили → записали» пропускала обоих, и клиент получал два одинаковых
    // платёжных документа от официального бота.
    const [first, second] = await Promise.all([
      claimPaymentReminder(db, { orderId: order.id, cooldownMs: 24 * 60 * 60 * 1000 }),
      claimPaymentReminder(db, { orderId: order.id, cooldownMs: 24 * 60 * 60 * 1000 }),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    const events = await getOrderEventsByOrderId(db, order.id);
    expect(events.filter((e) => e.eventType === 'payment_reminder_sent')).toHaveLength(1);
  });

  it('через сутки окно открывается снова', async () => {
    const user = await makeUser({ telegramId: `tg-pending-claim2-${++seq}` });
    const { order } = await makeOrderWithLiveInvoice(user.id, 'https://pay.example/claim2');

    expect(await claimPaymentReminder(db, { orderId: order.id, cooldownMs: 60_000 })).toBe(true);
    expect(await claimPaymentReminder(db, { orderId: order.id, cooldownMs: 60_000 })).toBe(false);
    // Окно меряется от отметки: с нулевым окном прошлая запись уже не мешает.
    expect(await claimPaymentReminder(db, { orderId: order.id, cooldownMs: 0 })).toBe(true);
  });
});

describe('панель: антифрод-холды (тикет 05)', () => {
  it('заказ на проверке банка попадает в список', async () => {
    const user = await makeUser({ telegramId: `tg-hold-${++seq}` });
    const { order, payment } = await makeOrderWithPendingPayment({ userId: user.id });
    await setPaymentProviderStatus(db, { paymentId: payment.id, providerStatus: 7 });
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'payment_review' });

    const { items: rows } = await listHoldsForPanel(db);
    const found = rows.find((r) => r.orderId === order.id);

    expect(found).toMatchObject({
      orderStatus: 'payment_review',
      lastProviderStatus: 7,
      client: { telegramId: user.telegramId },
    });
    expect(found?.lastProviderStatusAt).toBeInstanceOf(Date);
  });

  it('платёж с отказом провайдера виден, даже если заказ ещё ждёт оплаты', async () => {
    const user = await makeUser({ telegramId: `tg-hold-declined-${++seq}` });
    const { order, payment } = await makeOrderWithPendingPayment({ userId: user.id });
    await setPaymentProviderStatus(db, { paymentId: payment.id, providerStatus: 8 });

    const { items: rows } = await listHoldsForPanel(db);

    expect(rows.map((r) => r.orderId)).toContain(order.id);
  });

  it('обычный заказ без холда в список не попадает', async () => {
    const user = await makeUser({ telegramId: `tg-nohold-${++seq}` });
    const { order } = await makeOrderWithPendingPayment({ userId: user.id });

    const { items: rows } = await listHoldsForPanel(db);

    expect(rows.map((r) => r.orderId)).not.toContain(order.id);
  });

  it('разрешившийся холд уходит с экрана: оплаченный заказ не показываем', async () => {
    const user = await makeUser({ telegramId: `tg-hold-resolved-${++seq}` });
    const { order, payment } = await makeOrderWithPendingPayment({ userId: user.id });
    await setPaymentProviderStatus(db, { paymentId: payment.id, providerStatus: 7 });
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'paid' });

    const { items: rows } = await listHoldsForPanel(db);

    // Иначе экран «что требует внимания» копил бы уже закрытые истории.
    expect(rows.map((r) => r.orderId)).not.toContain(order.id);
  });

  it('заказ с двумя платежами: одна строка, и статус в ней — от СВЕЖЕГО платежа', async () => {
    const user = await makeUser({ telegramId: `tg-hold-two-${++seq}` });
    const { order, payment } = await makeOrderWithPendingPayment({ userId: user.id });
    // Первый счёт закрыт терминально — только после этого частичный UNIQUE
    // (не более одного ЖИВОГО инвойса на заказ) пропускает второй.
    await claimPaymentTerminal(db, payment.id);
    await setPaymentProviderStatus(db, { paymentId: payment.id, providerStatus: 8 });
    const second = await upsertPaymentByProviderRef(db, {
      orderId: order.id,
      provider: 'freekassa',
      providerRef: `hold-second-${++seq}`,
      amountRub: 50000,
    });
    await setPaymentProviderStatus(db, { paymentId: second.payment.id, providerStatus: 7 });
    // Возраст платежей задаём явно: два INSERT'а подряд могут лечь в одну
    // миллисекунду, и «свежий» перестал бы быть определён — тест зеленел бы
    // от совпадения, а не от правила.
    await db
      .update(schema.payments)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(schema.payments.id, payment.id));
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'payment_review' });

    const { items: rows } = await listHoldsForPanel(db);
    const mine = rows.filter((r) => r.orderId === order.id);

    expect(mine).toHaveLength(1);
    // Правило «показываем последнее, что провайдер сказал»: перевыставленный
    // счёт на проверке (7), а не отвергнутый первый (8). Прежняя версия брала
    // любой ненулевой статус и на этой паре врала.
    expect(mine[0]?.lastProviderStatus).toBe(7);
  });

  it('неопрошенный свежий счёт не прячет операцию, которую держит банк', async () => {
    // Клиенту перевыставили счёт, поллер его ещё не видел (статуса нет). На
    // экране обязана остаться операция С ХОЛДОМ: именно её номер менеджер
    // подставляет в обращение в поддержку Freekassa, и именно по ней банк
    // держит деньги. Показать пустой статус свежего счёта значило бы стереть
    // и причину попадания заказа на экран.
    const user = await makeUser({ telegramId: `tg-hold-fresh-null-${++seq}` });
    const { order, payment } = await makeOrderWithPendingPayment({ userId: user.id });
    await setPaymentProviderStatus(db, { paymentId: payment.id, providerStatus: 7 });
    await claimPaymentTerminal(db, payment.id);
    const fresh = await upsertPaymentByProviderRef(db, {
      orderId: order.id,
      provider: 'freekassa',
      providerRef: `hold-fresh-${++seq}`,
      amountRub: 50000,
    });
    await db
      .update(schema.payments)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(schema.payments.id, payment.id));
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'payment_review' });

    const { items } = await listHoldsForPanel(db, 100);
    const row = items.find((r) => r.orderId === order.id);

    expect(row?.lastProviderStatus).toBe(7);
    expect(row?.paymentId).toBe(payment.id);
    expect(row?.paymentId).not.toBe(fresh.payment.id);
  });

  it('«клиенту ушло» читается фактом доставки, а не выводится из статуса', async () => {
    const user = await makeUser({ telegramId: `tg-hold-notified-${++seq}` });
    const { order, payment } = await makeOrderWithPendingPayment({ userId: user.id });
    await setPaymentProviderStatus(db, { paymentId: payment.id, providerStatus: 7 });
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'payment_review' });

    // Заказ УЖЕ на проверке банка, но автосообщение могло не уйти: отправка
    // best-effort, и «бот заблокирован пользователем» гасится log.warn.
    // Лимит задан явно: в файле общая база, и на дефолтной странице свой заказ
    // однажды перестанет помещаться — тест упадёт с непонятным `undefined`.
    const before = await listHoldsForPanel(db, 100);
    expect(before.items.find((r) => r.orderId === order.id)?.clientNotifiedAt).toBeNull();
    // Заодно: страница, вместившая всё, не должна кричать «показаны не все».
    expect(before.hasMore).toBe(false);

    await appendOrderEvent(db, {
      orderId: order.id,
      eventType: PAYMENT_REVIEW_CLIENT_NOTIFIED_EVENT,
      actorType: 'system',
    });

    const after = await listHoldsForPanel(db, 100);
    expect(after.items.find((r) => r.orderId === order.id)?.clientNotifiedAt).toBeInstanceOf(Date);
  });

  it('ОДИН заказ с длинной историей счетов тоже даёт «есть ещё»', async () => {
    // Запас выборки — три платежа на заказ. Заказ с большим числом
    // перевыставлений съедает его в одиночку: заказов набралось меньше
    // страницы, но дальше потолка мы просто НЕ ЗНАЕМ, что есть. Молчаливый
    // хвост на экране, чья пустота означает «холдов нет», — прямая ложь.
    const user = await makeUser({ telegramId: `tg-hold-many-pay-${++seq}` });
    const { order, payment } = await makeOrderWithPendingPayment({ userId: user.id });
    await claimPaymentTerminal(db, payment.id);
    await setPaymentProviderStatus(db, { paymentId: payment.id, providerStatus: 7 });
    // limit=1 → потолок выборки 1*3+1 = 4 строки; делаем платежей заведомо больше.
    for (let i = 0; i < 6; i++) {
      const extra = await upsertPaymentByProviderRef(db, {
        orderId: order.id,
        provider: 'freekassa',
        providerRef: `hold-many-${++seq}`,
        amountRub: 50000,
      });
      await claimPaymentTerminal(db, extra.payment.id);
      await setPaymentProviderStatus(db, { paymentId: extra.payment.id, providerStatus: 7 });
    }
    await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'payment_review' });

    const page = await listHoldsForPanel(db, 1);

    expect(page.hasMore).toBe(true);
  });

  it('усечение списка холдов не молчит', async () => {
    // Прежний тест утверждал `Array.isArray(...)` — тавтология при
    // типизированном возврате. Проверяем то, что действительно может сломаться:
    // страница обрезана, и об этом СКАЗАНО. Молчаливый срез читается как
    // «холдов больше нет» — ровно наоборот смыслу экрана.
    const user = await makeUser({ telegramId: `tg-hold-page-${++seq}` });
    for (let i = 0; i < 2; i++) {
      const { order, payment } = await makeOrderWithPendingPayment({ userId: user.id });
      await setPaymentProviderStatus(db, { paymentId: payment.id, providerStatus: 7 });
      await transitionOrderDetailed(db, { orderId: order.id, toStatus: 'payment_review' });
    }

    const page = await listHoldsForPanel(db, 1);

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });
});

describe('findStuckInFulfillmentOrders — время входа В СТАТУС, а не paid_at', () => {
  const THIRTY_MIN = 30 * 60 * 1000;

  /**
   * Состояние собирается ПРЯМЫМИ вставками: событие журнала нельзя состарить
   * UPDATE'ом — `order_events` append-only на уровне триггера БД (инвариант 1),
   * и это правильно. INSERT с нужным временем триггер разрешает.
   */
  async function makeOrderInFulfillment(input: { enteredAgoMs: number; paidAgoMs: number | null }) {
    const user = await makeUser({ telegramId: `tg-stuck-${++seq}` });
    // Заказ создаётся ЧЕРНОВИКОМ: `createDraftOrder` пишет стартовое событие с
    // тем статусом, который ему передали, и оно оказалось бы свежее нашего —
    // `max()` брал бы его, а тест проверял бы не то, что заявляет.
    const order = await createDraftOrder(db, {
      userId: user.id,
      status: 'draft',
      customServiceDescription: 'stuck-test',
      amountRub: 50000,
      originalAmount: 500,
      originalCurrency: 'USD',
    });
    await db.execute(sql`UPDATE orders SET status = 'in_fulfillment' WHERE id = ${order.id}`);
    if (input.paidAgoMs !== null) {
      const paidAt = new Date(Date.now() - input.paidAgoMs).toISOString();
      await db.execute(
        sql`UPDATE orders SET paid_at = ${paidAt}::timestamptz WHERE id = ${order.id}`,
      );
    }
    await db.insert(schema.orderEvents).values({
      orderId: order.id,
      actorType: 'system',
      eventType: 'status_changed',
      fromStatus: 'paid',
      toStatus: 'in_fulfillment',
      createdAt: new Date(Date.now() - input.enteredAgoMs),
    });
    return order;
  }

  it('заказ, давно вошедший в работу, находится', async () => {
    const order = await makeOrderInFulfillment({
      enteredAgoMs: 3 * 3600_000,
      paidAgoMs: 3 * 3600_000,
    });

    const stuck = await findStuckInFulfillmentOrders(db, { olderThanMs: THIRTY_MIN });

    expect(stuck.map((o) => o.id)).toContain(order.id);
  });

  it('РУЧНАЯ выдача старого заказа не считается зависшей', async () => {
    // Регрессия тикета 06: оператор берёт в работу заказ, оплаченный неделю
    // назад. По прежнему условию (`paid_at < now-30мин`) он попадал в
    // «зависшие» с первой секунды, и Sentry-алёрт летел каждые пять минут всё
    // время ручной работы — настоящий случай утонул бы в этом шуме.
    const order = await makeOrderInFulfillment({
      enteredAgoMs: 1000,
      paidAgoMs: 7 * 24 * 3600_000,
    });

    const stuck = await findStuckInFulfillmentOrders(db, { olderThanMs: THIRTY_MIN });

    expect(stuck.map((o) => o.id)).not.toContain(order.id);
  });

  it('заказ БЕЗ paid_at тоже попадает под наблюдение', async () => {
    // Зеркальная дыра прежнего условия: `NULL < cutoff` — это NULL, поэтому
    // заказ без отметки оплаты не алёртился НИКОГДА.
    const order = await makeOrderInFulfillment({ enteredAgoMs: 3 * 3600_000, paidAgoMs: null });

    const stuck = await findStuckInFulfillmentOrders(db, { olderThanMs: THIRTY_MIN });

    expect(stuck.map((o) => o.id)).toContain(order.id);
  });

  it('заказ без события входа наблюдается по paid_at — страховка для старых строк', async () => {
    const user = await makeUser({ telegramId: `tg-stuck-legacy-${++seq}` });
    const order = await createDraftOrder(db, {
      userId: user.id,
      status: 'draft',
      customServiceDescription: 'stuck-legacy',
      amountRub: 50000,
      originalAmount: 500,
      originalCurrency: 'USD',
    });
    await db.execute(sql`UPDATE orders SET status = 'in_fulfillment' WHERE id = ${order.id}`);
    const paidAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    await db.execute(
      sql`UPDATE orders SET paid_at = ${paidAt}::timestamptz WHERE id = ${order.id}`,
    );

    const stuck = await findStuckInFulfillmentOrders(db, { olderThanMs: THIRTY_MIN });

    expect(stuck.map((o) => o.id)).toContain(order.id);
  });
});
