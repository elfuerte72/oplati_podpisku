import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  getDb,
  getOrderById,
  transitionOrder,
  upsertPaymentByProviderRef,
} from '@oplati/db';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
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
  if (headerToken !== expectedToken) {
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
      expiresInHours: 24,
      successUrl,
      kycRequired: false,
      ...(paymentMethod !== undefined ? { paymentMethod } : {}),
    });

    const invoice = invoiceResp.invoice;
    log.info({
      event: 'payments.create.invoice_created',
      orderId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      amountRub: order.amountRub,
    });

    const upsert = await upsertPaymentByProviderRef(db, {
      orderId,
      provider: 'loveandpay',
      providerRef: invoice.id,
      providerInvoiceNumber: invoice.invoiceNumber,
      amountRub: order.amountRub,
      status: 'pending',
      expiresAt: invoice.expiresAt ? new Date(invoice.expiresAt) : null,
      rawPayload: { invoice } as Record<string, unknown>,
    });

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
      expiresAt: invoice.expiresAt,
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
