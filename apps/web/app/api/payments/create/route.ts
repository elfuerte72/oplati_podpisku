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
import {
  isPaymentProviderUnavailable,
  PROVIDER_UNAVAILABLE_TEXT,
} from '@/lib/loveandpay/availability';
import { isPriceLockExpired } from '@/lib/payments/expiry';
import { timingSafeEqualStr } from '@/lib/security/timing-safe';
import { getLoveAndPayClient, LoveAndPayApiError } from '@/lib/loveandpay';

/**
 * POST /api/payments/create — внутренний endpoint, дёргается из tool-handler
 * `confirm_order` (см. Task 5.2 плана).
 *
 * Поток:
 *   1. Проверяем `X-Internal-Token` (защита от внешнего вызова).
 *   2. Загружаем order; status должен быть `ready_for_payment`, иначе 409.
 *   3. Создаём L&P invoice (amount = order.amountRub / 100 — L&P принимает рубли).
 *   4. Идемпотентный upsert payment по (provider, providerRef).
 *   5. Атомарный transitionOrder → `pending_payment`.
 *   6. Возвращаем { paymentUrl, qrPayload, expiresAt }.
 *
 * Внешний HTTP-вызов делаем ДО транзакции БД — иначе долгий L&P-запрос держит lock.
 * Идемпотентность по дублю — через `upsertPaymentByProviderRef` (UNIQUE constraint).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 60;

const log = childLogger('payments-create');

// Срок жизни счёта L&P (решение владельца 2026-07-18; было 24ч — СБП/карта
// оплачиваются за минуты, длинное окно = опцион на курс за счёт маржи).
const INVOICE_TTL_HOURS = 1;

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

  log.info({ event: 'payments.create.start', orderId, paymentMethod });

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

    // Гард минимума терминала (KANYON не принимает < 500 ₽). Ловим ДО вызова
    // L&P, иначе провайдер вернёт INTERNAL_ERROR с непрозрачным телом.
    const minAmountRubKopecks = serverEnv.LOVEANDPAY_MIN_AMOUNT_RUB * 100;
    if (order.amountRub < minAmountRubKopecks) {
      log.warn({
        event: 'payments.create.below_min',
        orderId,
        amountRubKopecks: order.amountRub,
        minAmountRubKopecks,
      });
      return NextResponse.json(
        {
          ok: false,
          error: 'below_min_amount',
          minAmountRub: serverEnv.LOVEANDPAY_MIN_AMOUNT_RUB,
          message: `Минимальная сумма оплаты — ${serverEnv.LOVEANDPAY_MIN_AMOUNT_RUB} ₽`,
        },
        { status: 422 },
      );
    }

    const amountRubFull = order.amountRub / 100;
    const successUrl = buildTelegramDeepLink(order.shortId);
    const description = `Оплата заказа ${order.shortId}`;

    const loveAndPay = getLoveAndPayClient();
    const invoiceResp = await loveAndPay.createInvoice({
      amount: amountRubFull,
      currency: 'RUB',
      description,
      customer: {},
      expiresInHours: INVOICE_TTL_HOURS,
      successUrl,
      kycRequired: false,
      ...(paymentMethod !== undefined ? { paymentMethod } : {}),
    });

    const invoice = invoiceResp.invoice;
    // paymentLink в схеме optional (в ответе на проверку статуса его нет), но в
    // ответе на СОЗДАНИЕ он обязателен — инвойс без ссылки на оплату непригоден.
    // Форсим явно, чтобы не отдать клиенту пустой paymentUrl.
    if (!invoice.paymentLink) {
      throw new LoveAndPayApiError({
        code: 'missing_payment_link',
        httpStatus: 502,
        message: 'L&P создал инвойс без paymentLink',
      });
    }
    log.info({
      event: 'payments.create.invoice_created',
      orderId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      amountRub: order.amountRub,
    });

    // Единый нормализованный срок инвойса: L&P не вернул expiresAt → считаем
    // сами от TTL. Один и тот же момент уходит в payment, orders.expires_at и
    // ответ клиенту — рассинхрон источников исключён.
    const invoiceExpiresAt = invoice.expiresAt
      ? new Date(invoice.expiresAt)
      : new Date(Date.now() + INVOICE_TTL_HOURS * 60 * 60 * 1000);

    let upsert: UpsertResult;
    try {
      upsert = await upsertPaymentByProviderRef(db, {
        orderId,
        provider: 'loveandpay',
        providerRef: invoice.id,
        providerInvoiceNumber: invoice.invoiceNumber,
        amountRub: order.amountRub,
        status: 'pending',
        expiresAt: invoiceExpiresAt,
        rawPayload: { invoice } as Record<string, unknown>,
      });
    } catch (err) {
      // Частичный unique payments_one_pending_per_order_idx (находка аудита I3):
      // два КОНКУРЕНТНЫХ confirm_order оба проходили проверку статуса выше и
      // создавали два живых инвойса — клиент мог оплатить второй по уже
      // завершённому заказу. Теперь проигравший INSERT получает 23505 —
      // возвращаем ему уже существующий pending-инвойс победителя (созданный
      // здесь invoice остаётся неоплаченным висяком в L&P и истечёт сам).
      if (!isPendingPaymentConflict(err)) throw err;
      log.warn({ event: 'payments.create.concurrent_duplicate', orderId });
      return await respondWithExistingPendingPayment(orderId, paymentMethod);
    }

    // Если payment был создан только что (isNew=true), двигаем order вперёд.
    // Иначе (дубль — повторный вызов confirm_order) — возвращаем существующий ссылочный invoice.
    if (upsert.isNew) {
      await transitionOrder(db, {
        orderId,
        toStatus: 'pending_payment',
        actorType: 'system',
        eventType: 'payment_invoice_created',
        payload: { paymentId: upsert.payment.id, invoiceId: invoice.id, paymentMethod: paymentMethod ?? 'any' },
      });
      // M-4: срок заказа выравнивается по сроку счёта — иначе cron
      // expire-payments мог похоронить заказ при ещё живом инвойсе (оплата
      // после экспайра = деньги приняты, фулфилмента нет).
      await setOrderExpiresAt(db, orderId, invoiceExpiresAt);
    } else {
      log.info({
        event: 'payments.create.duplicate',
        orderId,
        paymentId: upsert.payment.id,
      });
    }

    return NextResponse.json({
      ok: true,
      paymentUrl: invoice.paymentLink,
      qrPayload: invoice.qrPayload ?? null,
      expiresAt: invoiceExpiresAt.toISOString(),
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
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
    // Тех. сбой транспорта/провайдера (лежит прокси, таймаут, 5xx L&P) —
    // отличаем от прочих ошибок: клиент получает честное «технический сбой»,
    // а healthcheck прокси запускается сразу (не ждём 5-минутный cron) —
    // при упавшем VPS владельцу уходит DM.
    if (isPaymentProviderUnavailable(err)) {
      after(() => alertOnLoveAndPayProxyDown());
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

function buildTelegramDeepLink(shortId: string): string {
  // Возможно, имя бота лежит в TELEGRAM_BOT_TOKEN — в формате <id>:<secret>;
  // для прямой deep-link нужен `username`, которого в env нет. Используем APP_URL —
  // success-страница на нашем web, оттуда редирект на бот по `tg://`.
  const base = serverEnv.APP_URL.replace(/\/$/, '');
  return `${base}/payment-success?order=${encodeURIComponent(shortId)}`;
}

/** Форма инвойса, сохранённого в payments.raw_payload при создании. */
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
