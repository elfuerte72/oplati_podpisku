import { and, asc, eq, sql } from 'drizzle-orm';

import { payments } from '../schema.ts';
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
 * запись с `isNew=false`, иначе — создаёт с `isNew=true`. Используется в endpoint
 * `payments/create` (при дубле — не создаём второй invoice) и в `loveandpay/webhook`
 * (для recovery, если webhook пришёл раньше callback'а из `payments/create`).
 */
export async function upsertPaymentByProviderRef(
  db: DB,
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
 */
export async function claimPaymentTerminal(
  db: DB,
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
 * Платежи для cron `poll-payment` — pending, старше 10 минут (webhook должен бы уже
 * прийти) и не древнее 25 часов (TTL invoice'а — 24h). Сортируем по дате
 * создания: восстанавливаем старые первыми.
 *
 * `LIMIT` ограничивает один проход cron'а: при завале (массовый сбой webhook'ов
 * или недоступность L&P) не тянем все pending разом — каждый запрос к getInvoice
 * последователен, можно упереться в maxDuration. Хвост добьёт следующий запуск.
 */
const POLL_BATCH_LIMIT = 50;

export async function findPendingPaymentsForPoll(db: DB): Promise<PaymentRow[]> {
  return await db
    .select()
    .from(payments)
    .where(
      sql`${payments.status} = 'pending'
          AND ${payments.createdAt} < now() - interval '10 minutes'
          AND ${payments.createdAt} > now() - interval '25 hours'`,
    )
    .orderBy(asc(payments.createdAt))
    .limit(POLL_BATCH_LIMIT);
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
