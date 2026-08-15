import { and, asc, eq, sql } from 'drizzle-orm';

import { orders, payments } from '../schema.ts';
import type { DB, DBLike } from '../index.ts';
import type { PaymentProvider, PaymentStatus } from '@oplati/types';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Репозиторий платежей. Главный инвариант — идемпотентность webhook'ов через
 * `UNIQUE(provider, provider_ref)` + `INSERT ... ON CONFLICT DO NOTHING`. Повторный
 * вызов webhook'а с тем же invoice id не создаёт дубль и не выполняет повторный
 * переход статуса заказа (CLAUDE.md → инвариант 2).
 *
 * Все суммы — RUB-копейки (`integer`); никогда не numeric/float (CLAUDE.md → 3).
 */

export type PaymentRow = typeof payments.$inferSelect;

export type UpsertPaymentByProviderRefInput = {
  orderId: string;
  provider: PaymentProvider;
  providerRef: string;
  providerInvoiceNumber?: string | null;
  amountRub: number;
  status?: PaymentStatus;
  expiresAt?: Date | null;
  rawPayload?: Record<string, unknown> | null;
};

export type UpsertResult = {
  payment: PaymentRow;
  isNew: boolean;
};

/**
 * Идемпотентный upsert: если (provider, providerRef) уже есть — возвращает существующую
 * запись с `isNew=false`, иначе — создаёт с `isNew=true`. Единственный вызов —
 * endpoint `payments/create` (при дубле — не создаём второй invoice); webhook
 * платёж НЕ создаёт (L-7: прежний комментарий про recovery из webhook устарел —
 * неизвестный providerRef там отвечает `not_found` + Sentry).
 */
export async function upsertPaymentByProviderRef(
  // DBLike: с M-2 вызывается из транзакции payments/create (INSERT платежа +
  // переход заказа atomically — сбой перехода откатывает и INSERT).
  db: DBLike,
  input: UpsertPaymentByProviderRefInput,
  log: RepoLogger = noopLogger,
): Promise<UpsertResult> {
  const {
    orderId,
    provider,
    providerRef,
    providerInvoiceNumber = null,
    amountRub,
    status = 'pending',
    expiresAt = null,
    rawPayload = null,
  } = input;

  // ON CONFLICT (provider, provider_ref) DO NOTHING — если конфликт, вернёт пустой
  // массив. Тогда отдельным SELECT'ом достаём существующую запись.
  const inserted = await db
    .insert(payments)
    .values({
      orderId,
      provider,
      providerRef,
      providerInvoiceNumber,
      amountRub,
      status,
      expiresAt,
      rawPayload,
    })
    .onConflictDoNothing({ target: [payments.provider, payments.providerRef] })
    .returning();

  const fresh = inserted[0];
  if (fresh) {
    log.info({
      event: 'db.payments.created',
      paymentId: fresh.id,
      orderId,
      provider,
      providerRef,
      amountRub,
    });
    return { payment: fresh, isNew: true };
  }

  // Конфликт — SELECT существующую запись.
  const existing = await db
    .select()
    .from(payments)
    .where(and(eq(payments.provider, provider), eq(payments.providerRef, providerRef)))
    .limit(1);

  const row = existing[0];
  if (!row) {
    throw new Error(
      `upsertPaymentByProviderRef: ON CONFLICT DO NOTHING, но SELECT по (${provider}, ${providerRef}) ничего не вернул`,
    );
  }

  log.warn({
    event: 'db.payments.duplicate_upsert',
    paymentId: row.id,
    provider,
    providerRef,
  });

  return { payment: row, isNew: false };
}

export type MarkPaymentSucceededInput = {
  paymentId: string;
  webhookReceivedAt?: Date | null;
  rawPayload?: Record<string, unknown> | null;
  recoveredViaPolling?: boolean;
};

/**
 * Атомарный claim платежа: переводит `pending → succeeded` ОДНИМ условным
 * UPDATE и возвращает строку только тому вызову, который реально сделал переход.
 *
 * Зачем: webhook L&P и cron `poll-payment` могут обработать один и тот же invoice
 * почти одновременно. Безусловный UPDATE by id пропустил бы оба вызова дальше —
 * к двойному `dispatchIssueCard` и двойному топ-апу карты (реальная двойная
 * трата). Здесь `WHERE id=? AND status='pending'` гарантирует, что строку получит
 * ровно один параллельный вызов; второй увидит `null` и должен остановиться ДО
 * любых побочных эффектов (issue-card, уведомление).
 *
 * Этот же claim — наша anti-replay защита webhook'а: подпись L&P не содержит
 * timestamp/nonce, повтор перехваченного payload гасится именно идемпотентностью
 * claim'а. Не убирать условие `status='pending'` при рефакторинге.
 *
 * Принимает `DBLike`: вызывается из транзакции `processInvoicePaid` (claim +
 * переход заказа atomically — сбой перехода откатывает и claim).
 *
 * Возвращает `null`, если платёж уже не `pending` (повтор/гонка) или не найден.
 */
export async function claimPaymentSucceeded(
  db: DBLike,
  input: MarkPaymentSucceededInput,
  log: RepoLogger = noopLogger,
): Promise<PaymentRow | null> {
  const {
    paymentId,
    webhookReceivedAt = new Date(),
    rawPayload = null,
    recoveredViaPolling = false,
  } = input;

  const updated = await db
    .update(payments)
    .set({
      status: 'succeeded',
      completedAt: new Date(),
      webhookReceivedAt,
      recoveredViaPolling,
      ...(rawPayload !== null ? { rawPayload } : {}),
    })
    .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')))
    .returning();

  const row = updated[0];
  if (!row) {
    log.info({ event: 'db.payments.claim_skipped', paymentId, reason: 'not_pending' });
    return null;
  }

  log.info({
    event: 'db.payments.claimed_succeeded',
    paymentId,
    orderId: row.orderId,
    provider: row.provider,
    recoveredViaPolling,
  });

  return row;
}

/**
 * Атомарный claim платежа в терминальный статус `failed`: `pending → failed`
 * ОДНИМ условным UPDATE. Симметричен `claimPaymentSucceeded`.
 *
 * Зачем условие `status='pending'` (а не безусловный UPDATE by id): webhook
 * `invoice.paid` и терминальное событие (`expired`/`cancelled`) одного инвойса
 * могут прийти конкурентно на разных serverless-инстансах. Безусловный UPDATE
 * мог бы перезаписать уже `succeeded` платёж в `failed` (заказ оплачен, карта
 * выпущена, деньги приняты — а запись платежа стала `failed`: рассинхрон сверки,
 * риск ошибочного «возврата»). Условие гарантирует, что терминальный переход
 * применяется ТОЛЬКО к ещё живому (pending) платежу.
 *
 * Возвращает `null`, если платёж уже не `pending` (гонку выиграл paid-путь либо
 * повторное терминальное событие) — вызывающий трактует это как idempotent_skip.
 *
 * Принимает `DBLike`: вызывается из транзакции `processInvoiceTerminal` (claim +
 * переход заказа atomically — транзиентный сбой перехода откатывает и claim,
 * симметрично `claimPaymentSucceeded`).
 */
export async function claimPaymentTerminal(
  db: DBLike,
  paymentId: string,
  log: RepoLogger = noopLogger,
): Promise<PaymentRow | null> {
  const updated = await db
    .update(payments)
    .set({ status: 'failed', completedAt: new Date() })
    .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')))
    .returning();

  const row = updated[0];
  if (!row) {
    log.info({ event: 'db.payments.terminal_claim_skipped', paymentId, reason: 'not_pending' });
    return null;
  }

  log.info({ event: 'db.payments.terminal_claimed', paymentId, orderId: row.orderId });
  return row;
}

/**
 * Платежи для cron `poll-payment` — pending, старше 10 минут (уведомление
 * шлюза должно бы уже прийти) и не древнее 25 часов. Сортируем по дате
 * создания: восстанавливаем старые первыми.
 *
 * ⚠️ Фильтр `status='pending'` жёсткий: захороненный (`failed`) платёж этой
 * выборкой не подхватывается уже НИКОГДА. Поэтому финальная сверка со шлюзом
 * живёт в `expire-payments` ДО claim'а — иначе оплата в последние минуты жизни
 * счёта при потерянном уведомлении терялась молча (аудит 2026-08-10).
 *
 * Верхняя граница в 25 часов — исторический запас с эпохи суточного TTL счёта;
 * сейчас счёт живёт 1 час (`INVOICE_TTL_HOURS`), и запас лишь удлиняет окно
 * добора. Сужать его без нужды не стоит: он ничего не стоит и страхует
 * от долгих провалов крона.
 *
 * Исключение из верхней границы — заказ «на проверке банка» (антифрод-трек,
 * тикет 04): холд может висеть дольше суток, платёж при этом остаётся
 * `pending` и не хоронится экспайром — без исключения он выпадал бы из опроса
 * через 25 часов, и разрешение холда мы бы уже не увидели.
 */
const POLL_BATCH_LIMIT = 50;

export async function findPendingPaymentsForPoll(db: DB): Promise<PaymentRow[]> {
  return await db
    .select()
    .from(payments)
    .where(
      sql`${payments.status} = 'pending'
          AND ${payments.createdAt} < now() - interval '10 minutes'
          AND (
            ${payments.createdAt} > now() - interval '25 hours'
            OR EXISTS (
              SELECT 1 FROM ${orders}
              WHERE ${orders.id} = ${payments.orderId}
                AND ${orders.status} = 'payment_review'
            )
          )`,
    )
    .orderBy(asc(payments.createdAt))
    .limit(POLL_BATCH_LIMIT);
}

export type InvoiceConversion = { invoiced: number; paid: number };

/**
 * Конверсия «счёт выставлен → оплачен» за окно.
 *
 * Зачем: о том, что Love&Pay перестал проводить платежи, узнали от клиентов, а
 * не от системы — детектор недоступности ловит только транспорт, а «шлюз
 * отвечает 200, ссылку выдаёт, оплаты не проходят» для кода выглядит успехом.
 * Единственный сигнал такого отказа — падение конверсии.
 *
 * Окно со СДВИГОМ: считаем счета, выставленные в
 * `[now - windowMinutes, now - graceMinutes]`. Свежие счета исключены намеренно —
 * заказ, выставленный минуту назад, ещё не мог быть оплачен, и без отсрочки
 * метрика вечно показывала бы недоплаченные.
 *
 * `DISTINCT order_id` обязателен: повторный confirm пишет ещё одно событие
 * `payment_invoice_created` по тому же заказу (`duplicate: true`), и без
 * дедупликации один заказ считался бы дважды.
 */
export async function countInvoiceConversion(
  db: DB,
  params: { windowMinutes: number; graceMinutes: number },
): Promise<InvoiceConversion> {
  const rows = await db.execute<{ invoiced: string | number; paid: string | number }>(sql`
    WITH invoiced AS (
      SELECT DISTINCT order_id
      FROM order_events
      WHERE event_type = 'payment_invoice_created'
        AND created_at >= now() - make_interval(mins => ${params.windowMinutes}::int)
        AND created_at <= now() - make_interval(mins => ${params.graceMinutes}::int)
    )
    SELECT
      (SELECT count(*) FROM invoiced) AS invoiced,
      (SELECT count(*) FROM invoiced i
        WHERE EXISTS (
          SELECT 1 FROM order_events e
          WHERE e.order_id = i.order_id AND e.event_type = 'payment_succeeded'
        )) AS paid
  `);

  const row = rows[0];
  return {
    invoiced: Number(row?.invoiced ?? 0),
    paid: Number(row?.paid ?? 0),
  };
}

export async function findPaymentByProviderRef(
  db: DB,
  provider: PaymentProvider,
  providerRef: string,
): Promise<PaymentRow | null> {
  const rows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.provider, provider), eq(payments.providerRef, providerRef)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Платёж по НАШЕМУ идентификатору, который был отправлен провайдеру при создании
 * счёта (`payments.provider_invoice_number`).
 *
 * Нужен уведомлению Freekassa как ЗАПАСНОЙ путь поиска. Основной ключ —
 * `providerRef` (в уведомлении это `intid`), но равенство `intid` тому
 * `orderId`, который провайдер вернул при создании заказа, докой не
 * гарантировано и живым вызовом ещё не подтверждено. Если `intid` окажется
 * другим идентификатором, поиск по `MERCHANT_ORDER_ID` (= наш `paymentId`)
 * спасает оплату от статуса «платёж не найден» вместо потери заказа.
 *
 * Однозначность обеспечивает вызывающий код: `paymentId` генерируется
 * уникальным на попытку (`<shortId>-<hex>`), поэтому берём первую строку.
 */
export async function findPaymentByProviderInvoiceNumber(
  db: DB,
  provider: PaymentProvider,
  providerInvoiceNumber: string,
): Promise<PaymentRow | null> {
  const rows = await db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.provider, provider),
        eq(payments.providerInvoiceNumber, providerInvoiceNumber),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Действующий (pending) платёж заказа. Частичный unique
 * `payments_one_pending_per_order_idx` гарантирует не больше одного. Используется
 * в `payments/create` для идемпотентного ответа проигравшему гонку конкурентному
 * confirm_order (вместо второго живого инвойса).
 */
export async function findPendingPaymentByOrderId(
  db: DB,
  orderId: string,
): Promise<PaymentRow | null> {
  const rows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, 'pending')))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Платежи заказа для личного кабинета. Свежие первыми (первый — актуальный
 * invoice). Read-only.
 */
export async function findPaymentsByOrderId(db: DB, orderId: string): Promise<PaymentRow[]> {
  return await db
    .select()
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(sql`${payments.createdAt} DESC`);
}

/**
 * Записать последний код статуса, увиденный опросом провайдера (антифрод-трек,
 * тикет 03). Обычный UPDATE — `payments` не append-only; перезапись тем же
 * кодом безвредна и освежает `last_provider_status_at` (момент опроса).
 * Дедуп «сообщение клиенту один раз на платёж» читает ПРЕЖНЕЕ значение до
 * записи нового (пачка 3), поэтому порядок вызова важен вызывающему коду.
 */
export async function setPaymentProviderStatus(
  db: DBLike,
  input: { paymentId: string; providerStatus: number },
): Promise<void> {
  await db
    .update(payments)
    .set({ lastProviderStatus: input.providerStatus, lastProviderStatusAt: new Date() })
    .where(eq(payments.id, input.paymentId));
}

/**
 * Retention (M-13 аудита): очистка `raw_payload` у платежей старше
 * `olderThanDays` (решение владельца 2026-07-19 — 180 дней): сверка с
 * провайдером давно не нужна, а сырое тело инвойса — самая тяжёлая часть строки.
 * Сама строка платежа (суммы/статусы/ссылки на заказ) остаётся навсегда.
 * Возвращает число очищенных строк (батч `limit` за проход).
 */
export async function stripOldPaymentPayloads(
  db: DB,
  input: { olderThanDays: number; limit: number },
  log: RepoLogger = noopLogger,
): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE ${payments}
    SET raw_payload = NULL
    WHERE ${payments.id} IN (
      SELECT ${payments.id} FROM ${payments}
      WHERE ${payments.rawPayload} IS NOT NULL
        AND ${payments.createdAt} < now() - make_interval(days => ${input.olderThanDays})
      ORDER BY ${payments.createdAt} ASC
      LIMIT ${input.limit}
    )
    RETURNING ${payments.id} AS id
  `);
  const stripped = rows.length;
  if (stripped > 0) {
    log.info({ event: 'db.payments.retention_stripped', stripped, olderThanDays: input.olderThanDays });
  }
  return stripped;
}
