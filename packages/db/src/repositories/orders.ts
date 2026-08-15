import { randomBytes } from 'node:crypto';

import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';

import {
  orders,
  orderEvents,
  payments,
  type orderStatusEnum,
} from '../schema.ts';
import type { DB, DBLike } from '../index.ts';
import {
  isAllowedTransition,
  OrderTransitionError,
  type OrderStatus,
  type OrderParameters,
} from '@oplati/types';
import { noopLogger, type RepoLogger } from './logger.ts';
import { PURCHASED_STATUSES_SQL } from './order-status-sql.ts';

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
  /** Снимок надбавки за выпуск карты (RUB-копейки), уже включённой в amountRub. */
  cardIssueFeeKopecks?: number | null;
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
      // Строка заказа и её стартовое событие order_created — в ОДНОЙ транзакции
      // (инвариант A1/A4): иначе сбой БД между двумя INSERT оставил бы заказ без
      // события в append-only-логе (L2).
      const row = await db.transaction(async (tx) => {
        const inserted = await tx
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
            cardIssueFeeKopecks: input.cardIssueFeeKopecks ?? null,
            parameters: input.parameters ?? null,
            requiresKyc: input.requiresKyc ?? false,
          })
          .returning();

        const created = inserted[0];
        if (!created) {
          throw new Error('createDraftOrder: INSERT не вернул строку');
        }

        // Стартовое событие в order_events — append-only audit log.
        await tx.insert(orderEvents).values({
          orderId: created.id,
          actorType: 'system',
          eventType: 'order_created',
          fromStatus: null,
          toStatus: created.status,
          payload: { source: 'createDraftOrder' },
        });

        return created;
      });

      log.info({
        event: 'db.orders.created',
        orderId: row.id,
        shortId: row.shortId,
        userId: row.userId,
        status: row.status,
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
  db: DBLike,
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
  db: DBLike,
  input: TransitionOrderInput,
  log: RepoLogger = noopLogger,
): Promise<OrderRow> {
  const result = await transitionOrderDetailed(db, input, log);
  return result.order;
}

/**
 * Обновляет `orders.expires_at` (статус НЕ трогает — это не state-переход).
 *
 * Использование: при выставлении счёта срок заказа выравнивается по сроку
 * инвойса L&P (M-4 аудита 2026-07-18) — иначе cron `expire-payments` мог
 * похоронить заказ при ещё живом инвойсе: оплата после экспайра = деньги
 * приняты, фулфилмента нет.
 */
export async function setOrderExpiresAt(
  // DBLike: с M-2 вызывается из транзакции payments/create вместе с upsert
  // платежа и переходом заказа.
  db: DBLike,
  orderId: string,
  expiresAt: Date,
  log: RepoLogger = noopLogger,
): Promise<void> {
  await db.update(orders).set({ expiresAt }).where(eq(orders.id, orderId));
  log.info({ event: 'db.orders.expires_at_updated', orderId, expiresAt: expiresAt.toISOString() });
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

/**
 * Поиск оплатимых заказов с истёкшим `expires_at` — для cron `expire-payments`.
 *
 * Оба оплатимых статуса (H-2 аудита 2026-07-18): `pending_payment` (счёт
 * выставлен, не оплачен) И `ready_for_payment` (черновик с зафиксированной
 * ценой, счёт не выставлялся) — иначе черновик жил вечно и оставался оплатимым
 * по устаревшему снапшоту курса.
 *
 * `NOT EXISTS (успешный платёж)` — защита от захоронения ОПЛАЧЕННОГО заказа
 * (находка аудита C1): если сбой оставил payment=succeeded при заказе в
 * pending_payment, cron не должен переводить его в expired — такой заказ чинит
 * poll-payment/оператор, а не «срок оплаты истёк».
 */
const EXPIRE_BATCH_LIMIT = 200;

export async function findExpiredPayableOrders(db: DB): Promise<OrderRow[]> {
  return await db
    .select()
    .from(orders)
    .where(
      sql`${orders.status} IN ('ready_for_payment', 'pending_payment') AND ${orders.expiresAt} IS NOT NULL AND ${orders.expiresAt} < now()
          AND NOT EXISTS (
            SELECT 1 FROM ${payments}
            WHERE ${payments.orderId} = ${orders.id} AND ${payments.status} = 'succeeded'
          )`,
    )
    // Порядок + кап: без них накопленный бэклог (провалы крона, всплеск
    // заказов) выбирался бы целиком, обрывался по таймауту и переигрывался по
    // кругу, никогда не доходя до конца. С капом каждый прогон гарантированно
    // добивает свою пачку, а остаток забирает следующий через 15 минут.
    .orderBy(asc(orders.expiresAt))
    .limit(EXPIRE_BATCH_LIMIT);
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
const STUCK_BATCH_LIMIT = 50;

/**
 * Возвраты и недоплаты клиента за окно (антифрод-трек, тикет 11) — фундамент
 * под будущие правила, БЕЗ блокировок сегодня. Считает по СУЩЕСТВУЮЩИМ данным
 * (`order_events` + `orders`), новых таблиц нет:
 *   - недоплата (`payment_amount_mismatch`);
 *   - возврат у провайдера (терминальные события с providerStatus=6);
 *   - заказы, дошедшие до `refunded`.
 */
export async function countRefundishHistoryByUser(
  db: DB,
  input: { userId: string; withinDays: number },
): Promise<number> {
  // ⚠️ В raw-sql-фрагменты Date-объект передавать НЕЛЬЗЯ — только ISO-строку
  // (паттерн analytics.ts): без маппинга колонки postgres-js падает на
  // сериализации с TypeError «Received an instance of Date», а PGlite в тестах
  // Date переваривает — регресс виден только в проде (SENTRY-BYZANTIUM-BATTERY-1D).
  const cutoff = new Date(Date.now() - input.withinDays * 24 * 60 * 60 * 1000);
  const rows = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count
    FROM ${orderEvents}
    JOIN ${orders} ON ${orders.id} = ${orderEvents.orderId}
    WHERE ${orders.userId} = ${input.userId}
      AND ${orderEvents.createdAt} > ${cutoff.toISOString()}
      AND (
        ${orderEvents.eventType} = 'payment_amount_mismatch'
        OR (${orderEvents.payload} ->> 'providerStatus') = '6'
        OR ${orderEvents.toStatus} = 'refunded'
      )
  `);
  return rows[0]?.count ?? 0;
}

/**
 * Заказы, залипшие «на проверке банка» дольше порога (антифрод-трек, тикет 04):
 * предохранитель от вечного `payment_review` — DM владельцу, БЕЗ автозакрытия
 * (исход решает провайдер/оператор, автомат здесь потерял бы деньги клиента).
 *
 * Возраст меряется по событию входа в статус (`order_events.to_status =
 * 'payment_review'`, append-only журнал): `orders.updated_at` переходами не
 * трогается, а полагаться на него значило бы сбрасывать таймер любым UPDATE.
 */
export async function findStaleOrdersInPaymentReview(
  db: DB,
  input: { olderThanMs: number },
): Promise<OrderRow[]> {
  // ⚠️ Date в raw-sql-фрагмент не передавать — только ISO-строку (см.
  // комментарий в countRefundishHistoryByUser; SENTRY-BYZANTIUM-BATTERY-1D).
  const cutoff = new Date(Date.now() - input.olderThanMs);
  return await db
    .select()
    .from(orders)
    .where(
      sql`${orders.status} = 'payment_review' AND (
        SELECT max(${orderEvents.createdAt}) FROM ${orderEvents}
        WHERE ${orderEvents.orderId} = ${orders.id}
          AND ${orderEvents.toStatus} = 'payment_review'
      ) < ${cutoff.toISOString()}`,
    )
    .orderBy(asc(orders.createdAt))
    .limit(STUCK_BATCH_LIMIT);
}

export async function findStuckPaidOrders(
  db: DB,
  input: { olderThanMs: number },
): Promise<OrderRow[]> {
  const cutoff = new Date(Date.now() - input.olderThanMs);
  return await db
    .select()
    .from(orders)
    .where(and(eq(orders.status, 'paid'), lt(orders.paidAt, cutoff)))
    .orderBy(asc(orders.paidAt))
    .limit(STUCK_BATCH_LIMIT);
}

/**
 * Заказы, «зависшие» в `in_fulfillment`: claim `paid → in_fulfillment` прошёл, но
 * заказ не дошёл до `completed`/`failed`. Самый опасный кейс — инстанс умер ПОСЛЕ
 * успешного выпуска карты в провайдере, но ДО записи в нашу БД: карта реально
 * выпущена и оплачена из VCC-баланса, а recovery её НЕ переотрабатывает (claim
 * уже не вернёт transitioned — at-most-once против двойной траты). Такие заказы
 * нельзя авто-перевыпускать (риск двойного fee+суммы) — их разбирает оператор по
 * кабинету PaySpace. Эта функция только НАХОДИТ их для алёрта в `poll-payment`.
 *
 * `paidAt` как прокси времени входа в fulfillment: `in_fulfillment` следует за
 * `paid` в пределах секунд, отдельной метки времени для статуса нет.
 */
export async function findStuckInFulfillmentOrders(
  db: DB,
  input: { olderThanMs: number },
): Promise<OrderRow[]> {
  const cutoff = new Date(Date.now() - input.olderThanMs);
  return await db
    .select()
    .from(orders)
    .where(and(eq(orders.status, 'in_fulfillment'), lt(orders.paidAt, cutoff)))
    .orderBy(asc(orders.paidAt))
    .limit(STUCK_BATCH_LIMIT);
}

/**
 * Заказы для напоминания о продлении подписки — cron `subscription-renewal-reminder`.
 *
 * Окно фильтра (3 дня) ШИРЕ шага крона (сутки), поэтому один заказ попадал бы в
 * выборку несколько дней подряд → дубли напоминаний. `NOT EXISTS` исключает
 * заказы, по которым напоминание уже отправлено (событие `renewal_reminder_sent`
 * в append-only `order_events`) — идемпотентность на уровне выборки.
 */
const RENEWAL_BATCH_LIMIT = 200;

export async function findOrdersForRenewalReminder(db: DB): Promise<OrderRow[]> {
  return await db
    .select()
    .from(orders)
    .where(
      sql`${orders.status} = 'completed' AND ${orders.fulfilledAt} IS NOT NULL
          AND ${orders.fulfilledAt} BETWEEN now() - interval '26 days' AND now() - interval '23 days'
          AND NOT EXISTS (
            SELECT 1 FROM ${orderEvents}
            WHERE ${orderEvents.orderId} = ${orders.id}
              AND ${orderEvents.eventType} = 'renewal_reminder_sent'
          )`,
    )
    // Кап по той же причине, что в findExpiredPayableOrders. Здесь он ещё и
    // предохранитель от рассылки: сорваться на середине пачки лучше, чем
    // упереться в таймаут, отправив половину и не записав ни одного события.
    .orderBy(asc(orders.fulfilledAt))
    .limit(RENEWAL_BATCH_LIMIT);
}

/**
 * Атомарно «занять» право отправить напоминание о продлении.
 *
 * Возвращает `true` только тому, кто вставил событие первым; конкурент получает
 * `false` и молча пропускает заказ. Держится на частичном уникальном индексе
 * `order_events_renewal_reminder_once_idx` (миграция 0027) — прежняя схема
 * «выбрать через NOT EXISTS → отправить → записать» атомарной не была, и два
 * одновременных прогона джоба слали клиенту одно и то же дважды (B-2).
 *
 * ⚠️ Порядок намеренный: занимаем ДО отправки, то есть семантика at-most-once.
 * Обратный порядок (отправить → записать) дал бы at-least-once, но именно он и
 * порождал дубли, а `order_events` append-only — «отменить» занятую попытку
 * нечем. Сбой отправки после claim'а означает пропущенное напоминание; он не
 * тихий (лог + Sentry в джобе), а большинство отказов Telegram здесь всё равно
 * постоянные («бот заблокирован пользователем»), где повтор бесполезен.
 */
export async function claimRenewalReminder(db: DBLike, orderId: string): Promise<boolean> {
  const rows = await db
    .insert(orderEvents)
    .values({ orderId, actorType: 'system', eventType: 'renewal_reminder_sent' })
    .onConflictDoNothing()
    .returning({ id: orderEvents.id });
  return rows.length > 0;
}

/**
 * Записать событие в append-only `order_events` БЕЗ смены статуса заказа — для
 * не-переходных событий (напоминание о продлении, уведомление). `orders.status`
 * не трогается, поэтому `from_status`/`to_status` остаются null. Только INSERT
 * (append-only-триггер запрещает лишь UPDATE/DELETE).
 */
export async function appendOrderEvent(
  db: DBLike,
  input: {
    orderId: string;
    eventType: string;
    actorType: 'system' | 'user' | 'operator' | 'supervisor' | 'ai' | 'payment_provider';
    actorId?: string | null;
    payload?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db.insert(orderEvents).values({
    orderId: input.orderId,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    eventType: input.eventType,
    payload: input.payload ?? null,
  });
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

/**
 * Есть ли у пользователя хотя бы один «состоявшийся» заказ (оплачен/исполняется/
 * завершён). Гейт позднего захвата реферера: устоявшегося покупателя нельзя
 * задним числом привязать к чужой реф-ссылке (антифрод). `paid_at` не смотрим —
 * достаточно факта покупки.
 */
export async function hasPurchasedOrders(db: DB, userId: string): Promise<boolean> {
  const rows = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM orders
      WHERE user_id = ${userId}
        AND status IN ${PURCHASED_STATUSES_SQL}
    ) AS exists
  `);
  return rows[0]?.exists ?? false;
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: string }).code;
  return code === '23505';
}

/** Re-export типа enum для удобства call-site'ов. */
export type { orderStatusEnum };
