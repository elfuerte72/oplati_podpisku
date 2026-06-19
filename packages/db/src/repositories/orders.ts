import { randomBytes } from 'node:crypto';

import { and, eq, gt, lt, sql } from 'drizzle-orm';

import {
  orders,
  orderEvents,
  type orderStatusEnum,
} from '../schema.ts';
import type { DB } from '../index.ts';
import {
  isAllowedTransition,
  OrderTransitionError,
  type OrderStatus,
  type OrderParameters,
} from '@oplati/types';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Репозиторий заказов. Главный экспорт — `transitionOrder()`: единственный
 * легитимный путь смены `orders.status`. Прямой `UPDATE orders SET status = ...`
 * запрещён архитектурным инвариантом (CLAUDE.md, пункт 4). Любой переход
 * валидируется через `isAllowedTransition` (`@oplati/types`) ДО записи в БД;
 * `UPDATE orders` и `INSERT order_events` идут в одной транзакции.
 *
 * `shortId` (например `ORD-7KX42`) — человекочитаемый id, генерируется здесь
 * через `crypto.randomBytes(5)` → Crockford base32 (без I, L, O, U, чтобы не путать
 * с цифрами). Глобально уникален через UNIQUE constraint; коллизия 5-знаков на
 * 32^5 ≈ 33.5M вариантов крайне маловероятна.
 */

const SHORT_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateShortId(): string {
  const bytes = randomBytes(5);
  let s = '';
  for (let i = 0; i < 5; i++) {
    const b = bytes[i] ?? 0;
    s += SHORT_ID_ALPHABET[b % 32];
  }
  return `ORD-${s}`;
}

export type OrderRow = typeof orders.$inferSelect;

export type CreateDraftOrderInput = {
  userId: string;
  conversationId?: string | null;
  serviceId?: string | null;
  customServiceDescription?: string | null;
  /** Целевой статус сразу при создании. По умолчанию `'draft'`. */
  status?: OrderStatus;
  amountRub?: number | null;
  originalAmount?: number | null;
  originalCurrency?: string | null;
  usdtRubRateKopecks?: number | null;
  rateFixedAt?: Date | null;
  expiresAt?: Date | null;
  commissionPercent?: number | null;
  parameters?: OrderParameters | null;
  requiresKyc?: boolean;
};

/**
 * Создаёт новый заказ с уникальным `shortId`. Делает до 3 попыток на коллизию
 * `UNIQUE(short_id)` — на практике никогда не должно случиться.
 */
export async function createDraftOrder(
  db: DB,
  input: CreateDraftOrderInput,
  log: RepoLogger = noopLogger,
): Promise<OrderRow> {
  const status = input.status ?? 'draft';

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const shortId = generateShortId();
    try {
      const inserted = await db
        .insert(orders)
        .values({
          shortId,
          userId: input.userId,
          conversationId: input.conversationId ?? null,
          serviceId: input.serviceId ?? null,
          customServiceDescription: input.customServiceDescription ?? null,
          status,
          amountRub: input.amountRub ?? null,
          originalAmount: input.originalAmount ?? null,
          originalCurrency: input.originalCurrency ?? null,
          usdtRubRateKopecks: input.usdtRubRateKopecks ?? null,
          rateFixedAt: input.rateFixedAt ?? null,
          expiresAt: input.expiresAt ?? null,
          commissionPercent: input.commissionPercent ?? null,
          parameters: input.parameters ?? null,
          requiresKyc: input.requiresKyc ?? false,
        })
        .returning();

      const row = inserted[0];
      if (!row) {
        throw new Error('createDraftOrder: INSERT не вернул строку');
      }

      log.info({
        event: 'db.orders.created',
        orderId: row.id,
        shortId: row.shortId,
        userId: row.userId,
        status: row.status,
      });

      // Стартовое событие в order_events — append-only audit log.
      await db.insert(orderEvents).values({
        orderId: row.id,
        actorType: 'system',
        eventType: 'order_created',
        fromStatus: null,
        toStatus: row.status,
        payload: { source: 'createDraftOrder' },
      });

      return row;
    } catch (err) {
      lastError = err;
      // Постгрес duplicate key violation — пробуем ещё раз с новым shortId.
      if (isUniqueViolation(err) && attempt < 2) {
        log.warn({ event: 'db.orders.short_id_collision', shortId, attempt });
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export async function getOrderById(db: DB, id: string): Promise<OrderRow | null> {
  const rows = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getOrderByShortId(db: DB, shortId: string): Promise<OrderRow | null> {
  const rows = await db.select().from(orders).where(eq(orders.shortId, shortId)).limit(1);
  return rows[0] ?? null;
}

export type OrderEventRow = typeof orderEvents.$inferSelect;

/**
 * Заказы пользователя для личного кабинета (Telegram Mini App). Свежие первыми.
 * Read-only; вызывается после резолва userId по проверенному initData.
 */
export async function getOrdersByUserId(
  db: DB,
  userId: string,
  limit = 50,
): Promise<OrderRow[]> {
  return await db
    .select()
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(sql`${orders.createdAt} DESC`)
    .limit(limit);
}

/**
 * Таймлайн событий заказа (append-only `order_events`) для экрана заказа в
 * кабинете. Хронологический порядок (старые → новые). Read-only.
 */
export async function getOrderEventsByOrderId(
  db: DB,
  orderId: string,
): Promise<OrderEventRow[]> {
  return await db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(sql`${orderEvents.createdAt} ASC`);
}

export type TransitionOrderInput = {
  orderId: string;
  toStatus: OrderStatus;
  actorType?: 'system' | 'user' | 'operator' | 'supervisor' | 'ai' | 'payment_provider';
  actorId?: string | null;
  eventType?: string;
  payload?: Record<string, unknown> | null;
};

/**
 * Атомарно меняет статус заказа и пишет запись в `order_events`.
 *
 * 1. Загружает текущий `from` статус под `FOR UPDATE` lock.
 * 2. Проверяет `isAllowedTransition(from, to)`; если нет — `OrderTransitionError`.
 * 3. `UPDATE orders SET status = to, *_at = now()` (нужный timestamp по toStatus).
 * 4. `INSERT INTO order_events (from_status, to_status, event_type, payload)`.
 *
 * Всё в одной транзакции. Это единственный путь смены статуса в коде; прямой
 * `UPDATE orders SET status` запрещён архитектурным инвариантом.
 */
export type TransitionOrderResult = {
  order: OrderRow;
  /**
   * `true` — этот вызов реально выполнил переход (UPDATE + событие);
   * `false` — заказ уже был в `toStatus` (idempotent no-op).
   *
   * Нужно для атомарного «claim» побочных эффектов: например, issue-card
   * переводит `paid → in_fulfillment` и продолжает топ-ап карты ТОЛЬКО если
   * `transitioned === true` — иначе параллельный/повторный вызов сделает
   * двойную трату.
   */
  transitioned: boolean;
};

/**
 * Как `transitionOrder`, но возвращает ещё и флаг `transitioned` — сделал ли
 * именно этот вызов переход (vs idempotent no-op, когда заказ уже в `toStatus`).
 * Атомарность гарантируется `FOR UPDATE`-локом внутри транзакции.
 */
export async function transitionOrderDetailed(
  db: DB,
  input: TransitionOrderInput,
  log: RepoLogger = noopLogger,
): Promise<TransitionOrderResult> {
  const {
    orderId,
    toStatus,
    actorType = 'system',
    actorId = null,
    eventType = 'status_changed',
    payload = null,
  } = input;

  return await db.transaction(async (tx) => {
    // SELECT ... FOR UPDATE — блок исключающий race condition между webhook'ом и
    // cron'ом poll-payment, которые могут одновременно дёргать transitionOrder
    // на один и тот же order.
    const rows = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update')
      .limit(1);

    const current = rows[0];
    if (!current) {
      throw new Error(`transitionOrder: order ${orderId} not found`);
    }

    const fromStatus = current.status;
    if (fromStatus === toStatus) {
      // Идемпотентность: попытка перейти в уже текущий статус — no-op, без события.
      // Это нормальный путь при повторных webhook'ах.
      log.info({
        event: 'db.orders.transition_noop',
        orderId,
        status: fromStatus,
      });
      return { order: current, transitioned: false };
    }

    if (!isAllowedTransition(fromStatus, toStatus)) {
      throw new OrderTransitionError(orderId, fromStatus, toStatus);
    }

    // Карта таймстампов: каждому терминальному/ключевому статусу — свой *_at.
    // Не покрытые статусы (clarifying, pending_payment, ...) не имеют отдельного столбца.
    const timestampPatch: Partial<Record<
      'paidAt' | 'fulfilledAt' | 'cancelledAt' | 'refundedAt',
      Date
    >> = {};
    const now = new Date();
    if (toStatus === 'paid') timestampPatch.paidAt = now;
    if (toStatus === 'completed') timestampPatch.fulfilledAt = now;
    if (toStatus === 'cancelled' || toStatus === 'expired') timestampPatch.cancelledAt = now;
    if (toStatus === 'refunded') timestampPatch.refundedAt = now;

    const updated = await tx
      .update(orders)
      .set({ status: toStatus, ...timestampPatch })
      .where(eq(orders.id, orderId))
      .returning();

    const updatedRow = updated[0];
    if (!updatedRow) {
      throw new Error('transitionOrder: UPDATE не вернул строку');
    }

    await tx.insert(orderEvents).values({
      orderId,
      actorType,
      actorId,
      eventType,
      fromStatus,
      toStatus,
      payload,
    });

    log.info({
      event: 'db.orders.transition',
      orderId,
      from: fromStatus,
      to: toStatus,
      actorType,
      eventType,
    });

    return { order: updatedRow, transitioned: true };
  });
}

export async function transitionOrder(
  db: DB,
  input: TransitionOrderInput,
  log: RepoLogger = noopLogger,
): Promise<OrderRow> {
  const result = await transitionOrderDetailed(db, input, log);
  return result.order;
}

/** Устанавливает order.cardId — отдельной функцией, чтобы не плодить параметры в transitionOrder. */
export async function setOrderCardId(
  db: DB,
  orderId: string,
  cardId: string,
  log: RepoLogger = noopLogger,
): Promise<void> {
  await db.update(orders).set({ cardId }).where(eq(orders.id, orderId));
  log.info({ event: 'db.orders.card_assigned', orderId, cardId });
}

/** Поиск заказов с истекшим pending_payment — для cron `expire-payments`. */
export async function findExpiredPendingOrders(db: DB): Promise<OrderRow[]> {
  return await db
    .select()
    .from(orders)
    .where(
      sql`${orders.status} = 'pending_payment' AND ${orders.expiresAt} IS NOT NULL AND ${orders.expiresAt} < now()`,
    );
}

/**
 * Заказы, «зависшие» в `paid`: оплата прошла (статус `paid` ставит только
 * `processInvoicePaid` после успешного платежа), но fulfillment не стартовал —
 * issue-card мог потеряться при cold-shutdown инстанса (`setImmediate`
 * fire-and-forget). Cron `poll-payment` повторно диспатчит выпуск карты для них.
 *
 * `olderThanMs` отсекает только что оплаченные заказы, чей issue-card ещё может
 * выполняться в фоне (не дёргаем выпуск дважды без необходимости).
 */
export async function findStuckPaidOrders(
  db: DB,
  input: { olderThanMs: number },
): Promise<OrderRow[]> {
  const cutoff = new Date(Date.now() - input.olderThanMs);
  return await db
    .select()
    .from(orders)
    .where(and(eq(orders.status, 'paid'), lt(orders.paidAt, cutoff)));
}

/** Заказы для напоминания о продлении подписки — cron `subscription-renewal-reminder`. */
export async function findOrdersForRenewalReminder(db: DB): Promise<OrderRow[]> {
  return await db
    .select()
    .from(orders)
    .where(
      sql`${orders.status} = 'completed' AND ${orders.fulfilledAt} IS NOT NULL
          AND ${orders.fulfilledAt} BETWEEN now() - interval '26 days' AND now() - interval '23 days'`,
    );
}

/**
 * Возвращает `true`, если за последние `withinMs` миллисекунд по этому
 * `orderId` уже был записан event с указанным `eventType`. Используется для
 * идемпотентности AI-tool'ов (request_human и т.п.), чтобы повторный вызов
 * не плодил дубли в `order_events`.
 */
export async function hasRecentOrderEvent(
  db: DB,
  input: { orderId: string; eventType: string; withinMs: number },
): Promise<boolean> {
  const cutoff = new Date(Date.now() - input.withinMs);
  const rows = await db
    .select({ id: orderEvents.id })
    .from(orderEvents)
    .where(
      and(
        eq(orderEvents.orderId, input.orderId),
        eq(orderEvents.eventType, input.eventType),
        gt(orderEvents.createdAt, cutoff),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Сколько заказов пользователь создал за последние `withinMs` миллисекунд
 * (любой статус — считаем сам факт создания строки). Анти-абьюз лимит для
 * `propose_order`: jailbreak-нутая модель или спамер не должны заваливать
 * `orders` черновиками.
 */
export async function countRecentOrdersByUser(
  db: DB,
  input: { userId: string; withinMs: number },
): Promise<number> {
  const cutoff = new Date(Date.now() - input.withinMs);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.userId, input.userId), gt(orders.createdAt, cutoff)));
  return rows[0]?.count ?? 0;
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: string }).code;
  return code === '23505';
}

/** Re-export типа enum для удобства call-site'ов. */
export type { orderStatusEnum };
