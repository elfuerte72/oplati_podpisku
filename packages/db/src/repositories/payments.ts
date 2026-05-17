import { and, eq, sql } from 'drizzle-orm';

import { payments } from '../schema.ts';
import type { DB } from '../index.ts';
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

export async function markPaymentSucceeded(
  db: DB,
  input: MarkPaymentSucceededInput,
  log: RepoLogger = noopLogger,
): Promise<PaymentRow> {
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
    .where(eq(payments.id, paymentId))
    .returning();

  const row = updated[0];
  if (!row) {
    throw new Error(`markPaymentSucceeded: payment ${paymentId} не найден`);
  }

  log.info({
    event: 'db.payments.succeeded',
    paymentId,
    orderId: row.orderId,
    provider: row.provider,
    recoveredViaPolling,
  });

  return row;
}

export async function markPaymentStatus(
  db: DB,
  paymentId: string,
  status: PaymentStatus,
  log: RepoLogger = noopLogger,
): Promise<PaymentRow> {
  const updated = await db
    .update(payments)
    .set({
      status,
      ...(status === 'succeeded' || status === 'failed' || status === 'refunded'
        ? { completedAt: new Date() }
        : {}),
    })
    .where(eq(payments.id, paymentId))
    .returning();

  const row = updated[0];
  if (!row) {
    throw new Error(`markPaymentStatus: payment ${paymentId} не найден`);
  }

  log.info({ event: 'db.payments.status_changed', paymentId, status });
  return row;
}

/**
 * Платежи для cron `poll-payment` — pending, старше 10 минут (webhook должен бы уже
 * прийти) и не древнее 25 часов (TTL invoice'а — 24h). Сортируем по дате
 * создания: восстанавливаем старые первыми.
 */
export async function findPendingPaymentsForPoll(db: DB): Promise<PaymentRow[]> {
  return await db
    .select()
    .from(payments)
    .where(
      sql`${payments.status} = 'pending'
          AND ${payments.createdAt} < now() - interval '10 minutes'
          AND ${payments.createdAt} > now() - interval '25 hours'`,
    );
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
