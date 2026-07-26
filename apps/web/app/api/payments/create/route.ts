import * as Sentry from '@sentry/nextjs';
import { after, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  findPendingPaymentByOrderId,
  getDb,
  getOrderById,
  setOrderExpiresAt,
  transitionOrder,
  upsertPaymentByProviderRef,
  type UpsertResult,
} from '@oplati/db';
import { OrderTransitionError } from '@oplati/types';

import { serverEnv } from '@/lib/env.server';
import { alertOnLoveAndPayProxyDown } from '@/lib/jobs/proxy-health';
import { childLogger } from '@/lib/logger';
import { PROVIDER_UNAVAILABLE_TEXT } from '@/lib/loveandpay/availability';
import { isPaymentGatewayUnavailable } from '@/lib/payments/availability';
import { isPriceLockExpired } from '@/lib/payments/expiry';
import {
  createGatewayInvoice,
  minAmountRubFor,
  primaryPaymentGateway,
} from '@/lib/payments/gateway';
import { timingSafeEqualStr } from '@/lib/security/timing-safe';
import { LoveAndPayApiError } from '@/lib/loveandpay';

/**
 * POST /api/payments/create — внутренний endpoint, дёргается из tool-handler
 * `confirm_order` (см. Task 5.2 плана).
 *
 * Поток:
 *   1. Проверяем `X-Internal-Token` (защита от внешнего вызова).
 *   2. Загружаем order; status должен быть `ready_for_payment`, иначе 409.
 *   3. Создаём счёт у ТЕКУЩЕГО шлюза (`PAYMENT_PRIMARY_PROVIDER` — L&P или
 *      Freekassa; развилка целиком в `lib/payments/gateway.ts`).
 *   4. Идемпотентный upsert payment по (provider, providerRef).
 *   5. Атомарный transitionOrder → `pending_payment`.
 *   6. Возвращаем { paymentUrl, qrPayload, expiresAt }.
 *
 * ⚠️ Это ЕДИНСТВЕННОЕ место, зависящее от переключателя провайдера: вебхуки
 * обоих шлюзов принимают деньги всегда (ТЗ, этап 3).
 *
 * Внешний HTTP-вызов делаем ДО транзакции БД — иначе долгий запрос к шлюзу
 * держит lock. Идемпотентность по дублю — через `upsertPaymentByProviderRef`.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 60;

const log = childLogger('payments-create');

const requestSchema = z.object({
  orderId: z.string().uuid(),
  paymentMethod: z.enum(['sbp', 'card']).optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  const expectedToken = serverEnv.INTERNAL_API_TOKEN;
  if (!expectedToken) {
    log.error({ event: 'payments.create.misconfigured', missing: 'INTERNAL_API_TOKEN' });
    return NextResponse.json({ ok: false, error: 'misconfigured' }, { status: 500 });
  }

  const headerToken = req.headers.get('x-internal-token');
  if (!timingSafeEqualStr(headerToken ?? '', expectedToken)) {
    log.warn({ event: 'payments.create.unauthorized' });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    log.warn({ event: 'payments.create.invalid_json', err });
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    log.warn({
      event: 'payments.create.invalid_body',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 400 });
  }

  const { orderId, paymentMethod } = parsed.data;

  // Кто принимает деньги прямо сейчас. Читаем ДО try: значение нужно и в
  // обработчике ошибок (healthcheck прокси дёргаем только для L&P).
  const gateway = primaryPaymentGateway();

  log.info({ event: 'payments.create.start', orderId, paymentMethod, gateway });

  try {
    const db = getDb();
    const order = await getOrderById(db, orderId);
    if (!order) {
      log.warn({ event: 'payments.create.order_not_found', orderId });
      return NextResponse.json({ ok: false, error: 'order_not_found' }, { status: 404 });
    }
    if (order.status !== 'ready_for_payment') {
      // Повторный confirm по заказу с уже выставленным счётом — идемпотентный
      // успех: отдаём живой pending-инвойс вместо 409. Кейс реальный, а не
      // только двойной клик: счёт мог создать бот при привязке Telegram
      // (handoff в handleLinkDeepLink), а живая веб-вкладка после привязки
      // повторяет подтверждение того же заказа.
      if (order.status === 'pending_payment') {
        log.info({ event: 'payments.create.repeat_confirm', orderId });
        return await respondWithExistingPendingPayment(orderId, paymentMethod);
      }
      log.warn({
        event: 'payments.create.invalid_status',
        orderId,
        status: order.status,
      });
      return NextResponse.json(
        { ok: false, error: 'invalid_status', status: order.status },
        { status: 409 },
      );
    }
    // Гейт фиксации цены (H-2): черновик с истёкшим expires_at не доводим до
    // счёта — курс в нём устарел. Хороним сразу (cron сделал бы то же в
    // пределах 15 минут) и отвечаем 409, чтобы клиент оформил заказ заново.
    if (isPriceLockExpired(order)) {
      log.warn({
        event: 'payments.create.order_expired',
        orderId,
        expiresAt: order.expiresAt,
      });
      try {
        await transitionOrder(db, {
          orderId,
          toStatus: 'expired',
          actorType: 'system',
          eventType: 'order_expired',
          payload: { shortId: order.shortId, reason: 'price_lock_expired' },
        });
      } catch (err) {
        // Гонка с cron expire-payments: заказ уже захоронен — ответ тот же.
        if (!(err instanceof OrderTransitionError)) throw err;
        log.info({ event: 'payments.create.order_expired_race', orderId });
      }
      return NextResponse.json(
        {
          ok: false,
          error: 'order_expired',
          message: 'Срок фиксации цены истёк — оформите заказ заново.',
        },
        { status: 409 },
      );
    }

    if (!order.amountRub || order.amountRub <= 0) {
      log.error({ event: 'payments.create.invalid_amount', orderId, amountRub: order.amountRub });
      return NextResponse.json({ ok: false, error: 'invalid_amount' }, { status: 400 });
    }

    // Гард минимума шлюза (у L&P терминал KANYON не принимает < 500 ₽). Ловим
    // ДО вызова провайдера, иначе получим непрозрачное тело ошибки. У Freekassa
    // минимум не объявлен → по умолчанию гейта нет (см. `minAmountRubFor`).
    const minAmountRub = minAmountRubFor(gateway);
    if (minAmountRub > 0 && order.amountRub < minAmountRub * 100) {
      log.warn({
        event: 'payments.create.below_min',
        orderId,
        gateway,
        amountRubKopecks: order.amountRub,
        minAmountRubKopecks: minAmountRub * 100,
      });
      return NextResponse.json(
        {
          ok: false,
          error: 'below_min_amount',
          minAmountRub,
          message: `Минимальная сумма оплаты — ${minAmountRub} ₽`,
        },
        { status: 422 },
      );
    }

    // Narrowing `order.amountRub` (guard выше) не переживает closure транзакции.
    const orderAmountKopecks = order.amountRub;

    const invoice = await createGatewayInvoice({
      gateway,
      order,
      amountKopecks: orderAmountKopecks,
      paymentMethod,
    });

    log.info({
      event: 'payments.create.invoice_created',
      orderId,
      gateway: invoice.provider,
      providerRef: invoice.providerRef,
      invoiceNumber: invoice.providerInvoiceNumber,
      amountRub: orderAmountKopecks,
    });

    const invoiceExpiresAt = invoice.expiresAt;

    // INSERT платежа + переход заказа + выравнивание срока — В ОДНОЙ транзакции
    // (M-2 аудита 2026-07-18). Раньше это были отдельные await'ы: транзиентный
    // сбой БД между ними оставлял живой L&P-инвойс с pending-платежом при
    // заказе в ready_for_payment — оплата такого счёта упиралась в запрещённый
    // переход ready_for_payment→paid, fulfillment не стартовал. Теперь сбой
    // любого шага откатывает всё: платежа нет, заказ не тронут, повторный
    // confirm создаст новый счёт начисто.
    let upsert: UpsertResult;
    try {
      upsert = await db.transaction(async (tx) => {
        const u = await upsertPaymentByProviderRef(tx, {
          orderId,
          // Имя провайдера — по ФАКТУ выставления счёта, а не выводится из
          // флага задним числом: иначе после переключения история платежей
          // начнёт врать (ТЗ, этап 3).
          provider: invoice.provider,
          providerRef: invoice.providerRef,
          providerInvoiceNumber: invoice.providerInvoiceNumber,
          amountRub: orderAmountKopecks,
          status: 'pending',
          expiresAt: invoiceExpiresAt,
          rawPayload: invoice.rawPayload,
        });
        // isNew=true — двигаем order вперёд; дубль (повторный confirm_order)
        // просто вернёт существующий инвойс без переходов.
        if (u.isNew) {
          await transitionOrder(tx, {
            orderId,
            toStatus: 'pending_payment',
            actorType: 'system',
            eventType: 'payment_invoice_created',
            payload: {
              paymentId: u.payment.id,
              provider: invoice.provider,
              invoiceId: invoice.providerRef,
              paymentMethod: paymentMethod ?? 'any',
            },
          });
          // M-4: срок заказа выравнивается по сроку счёта — иначе cron
          // expire-payments мог похоронить заказ при ещё живом инвойсе (оплата
          // после экспайра = деньги приняты, фулфилмента нет).
          await setOrderExpiresAt(tx, orderId, invoiceExpiresAt);
        }
        return u;
      });
    } catch (err) {
      // Частичный unique payments_one_pending_per_order_idx (находка аудита I3):
      // два КОНКУРЕНТНЫХ confirm_order оба проходили проверку статуса выше и
      // создавали два живых инвойса — клиент мог оплатить второй по уже
      // завершённому заказу. Проигравший INSERT получает 23505 (транзакция
      // откатывается целиком) — возвращаем ему уже существующий pending-инвойс
      // победителя (созданный здесь счёт остаётся висяком у шлюза и истечёт сам).
      //
      // Тот же путь закрывает и смену провайдера при живом счёте прежнего
      // (ТЗ, этап 3): заказ с pending-платежом уже имеет статус
      // `pending_payment`, поэтому до создания нового счёта дело не доходит —
      // клиент получает рабочую ссылку прежнего шлюза, чей вебхук намеренно
      // продолжает принимать деньги. Гасить чужой pending через
      // `claimPaymentTerminal` не требуется.
      if (!isPendingPaymentConflict(err)) throw err;
      log.warn({ event: 'payments.create.concurrent_duplicate', orderId });
      return await respondWithExistingPendingPayment(orderId, paymentMethod);
    }

    if (!upsert.isNew) {
      log.info({
        event: 'payments.create.duplicate',
        orderId,
        paymentId: upsert.payment.id,
      });
    }

    return NextResponse.json({
      ok: true,
      paymentUrl: invoice.paymentUrl,
      qrPayload: invoice.qrPayload,
      expiresAt: invoiceExpiresAt.toISOString(),
      invoiceId: invoice.providerRef,
      invoiceNumber: invoice.providerInvoiceNumber,
    });
  } catch (err) {
    const isApiErr = err instanceof LoveAndPayApiError;
    log.error({
      event: 'payments.create.failed',
      orderId,
      code: isApiErr ? err.code : undefined,
      httpStatus: isApiErr ? err.httpStatus : undefined,
      err,
    });
    Sentry.captureException(err, {
      tags: { source: 'payments.create', orderId },
    });
    // Тех. сбой транспорта/провайдера (лежит прокси, таймаут, 5xx шлюза) —
    // отличаем от прочих ошибок: клиент получает честное «технический сбой».
    // Healthcheck прокси дёргаем только для L&P: у Freekassa своего прокси нет
    // (egress прямой), и лишний CONNECT-пробник на её сбое лишь шумел бы.
    if (isPaymentGatewayUnavailable(err)) {
      if (gateway === 'loveandpay') {
        after(() => alertOnLoveAndPayProxyDown());
      }
      return NextResponse.json(
        { ok: false, error: 'provider_unavailable', message: PROVIDER_UNAVAILABLE_TEXT },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'internal_error', code: isApiErr ? err.code : 'unknown' },
      { status: 500 },
    );
  }
}

/**
 * Форма инвойса, сохранённого в payments.raw_payload при создании.
 * Конверт `{ invoice: {...} }` общий для обоих шлюзов (см. `lib/payments/gateway.ts`),
 * поэтому повторный confirm отдаёт ссылку, не зная, кто выставил счёт.
 */
const storedInvoiceSchema = z.object({
  invoice: z.object({
    id: z.string(),
    invoiceNumber: z.string().optional().nullable(),
    paymentLink: z.string().optional().nullable(),
    qrPayload: z.string().optional().nullable(),
    expiresAt: z.string().optional().nullable(),
  }),
});

/** 23505 по частичному unique `payments_one_pending_per_order_idx` (гонка confirm_order). */
function isPendingPaymentConflict(err: unknown): boolean {
  const candidates: unknown[] = [err];
  if (typeof err === 'object' && err !== null && 'cause' in err) {
    candidates.push((err as { cause?: unknown }).cause);
  }
  for (const c of candidates) {
    if (typeof c !== 'object' || c === null) continue;
    const { code, constraint_name: constraint, message } = c as {
      code?: string;
      constraint_name?: string;
      message?: string;
    };
    if (
      code === '23505' &&
      (constraint === 'payments_one_pending_per_order_idx' ||
        (message?.includes('payments_one_pending_per_order_idx') ?? false))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Идемпотентный ответ проигравшему гонку: отдаём pending-инвойс победителя из
 * raw_payload. Заодно страхуем переход заказа в pending_payment (noop, если
 * победитель уже перевёл; OrderTransitionError глотаем — статус двинулся дальше).
 */
async function respondWithExistingPendingPayment(
  orderId: string,
  paymentMethod: 'sbp' | 'card' | undefined,
): Promise<NextResponse> {
  const db = getDb();
  const existing = await findPendingPaymentByOrderId(db, orderId);
  const parsed = existing ? storedInvoiceSchema.safeParse(existing.rawPayload) : null;

  if (!existing || !parsed?.success || !parsed.data.invoice.paymentLink) {
    // Инвойс победителя недоступен (не должен случаться: raw_payload пишется
    // при создании) — ведём себя как последовательный дубль: 409 invalid_status.
    log.error({ event: 'payments.create.duplicate_without_invoice', orderId });
    return NextResponse.json(
      { ok: false, error: 'invalid_status', status: 'pending_payment' },
      { status: 409 },
    );
  }

  try {
    await transitionOrder(db, {
      orderId,
      toStatus: 'pending_payment',
      actorType: 'system',
      eventType: 'payment_invoice_created',
      payload: { paymentId: existing.id, invoiceId: parsed.data.invoice.id, paymentMethod: paymentMethod ?? 'any', duplicate: true },
    });
  } catch (err) {
    if (!(err instanceof OrderTransitionError)) throw err;
    // Заказ уже ушёл дальше pending_payment — ссылку всё равно возвращаем,
    // платить по ней или нет, разрулит webhook (claim идемпотентен).
    log.warn({ event: 'payments.create.duplicate_transition_skipped', orderId, err });
  }

  const inv = parsed.data.invoice;
  return NextResponse.json({
    ok: true,
    paymentUrl: inv.paymentLink,
    qrPayload: inv.qrPayload ?? null,
    expiresAt: inv.expiresAt ?? null,
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber ?? null,
  });
}
