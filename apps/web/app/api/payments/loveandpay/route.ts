import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { loveAndPayWebhookEventSchema } from '@oplati/types';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { verifyWebhookSignature } from '@/lib/loveandpay';
import {
  processInvoicePaid,
  processInvoiceTerminal,
} from '@/lib/loveandpay/handlers';

/**
 * POST /api/payments/loveandpay — webhook Love & Pay.
 *
 * Контракт (CLAUDE.md инвариант 6 — webhook всегда 200 OK):
 *   1. rawBody читаем `request.text()` ДО JSON.parse — критично для HMAC
 *      (см. `lib/loveandpay/sign.ts`).
 *   2. Заголовок `X-Webhook-Signature` (`sha256=<hex>`); тип события — в теле (`event`),
 *      отдельного `X-Webhook-Event` у реального webhook'а нет.
 *   3. Невалидная подпись / отсутствие подписи → 200 OK + Sentry warning.
 *   4. Невалидный Zod → 200 OK + Sentry warning.
 *   5. Любой throw внутри handler'ов → 200 OK + Sentry.
 *
 * Идемпотентность — на уровне `processInvoicePaid` / `processInvoiceTerminal`:
 *   повторный invoice.paid с тем же id не приведёт к повторному переходу
 *   статуса (см. `lib/loveandpay/handlers.ts` + `transitionOrder` noop).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 30;

const log = childLogger('loveandpay-webhook');

const ok = (extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: true, ...extra }, { status: 200 });

export async function POST(req: Request): Promise<NextResponse> {
  // rawBody читаем СРАЗУ и один раз — он нужен для HMAC (подпись считается по
  // байт-в-байт телу до JSON.parse).
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    log.error({ event: 'loveandpay.webhook.read_body_failed', err });
    Sentry.captureException(err, { tags: { source: 'loveandpay.webhook' } });
    return ok({ skipped: 'read_failed' });
  }

  const webhookSecret = serverEnv.LOVEANDPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    log.warn({ event: 'loveandpay.webhook.disabled', missing: 'LOVEANDPAY_WEBHOOK_SECRET' });
    return ok({ skipped: 'not_configured' });
  }

  // Реальный webhook L&P шлёт ТОЛЬКО `X-Webhook-Signature` — заголовка
  // `X-Webhook-Event` нет, тип события берём из тела (`event`). Требуем подпись.
  const signatureHeader = req.headers.get('x-webhook-signature');

  if (!signatureHeader) {
    log.warn({ event: 'loveandpay.webhook.missing_signature' });
    Sentry.captureMessage('L&P webhook без X-Webhook-Signature', {
      level: 'warning',
      tags: { source: 'loveandpay.webhook' },
    });
    return ok({ skipped: 'missing_signature' });
  }

  if (!verifyWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
    log.warn({ event: 'loveandpay.webhook.invalid_signature' });
    Sentry.captureMessage('L&P webhook: невалидная подпись', {
      level: 'error',
      tags: { source: 'loveandpay.webhook' },
    });
    return ok({ skipped: 'invalid_signature' });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch (err) {
    log.warn({ event: 'loveandpay.webhook.invalid_json', err });
    Sentry.captureException(err, { tags: { source: 'loveandpay.webhook' } });
    return ok({ skipped: 'invalid_json' });
  }

  const parsed = loveAndPayWebhookEventSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn({
      event: 'loveandpay.webhook.invalid_payload',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    Sentry.captureMessage('L&P webhook: payload не прошёл Zod', {
      level: 'warning',
      tags: { source: 'loveandpay.webhook' },
    });
    return ok({ skipped: 'invalid_payload' });
  }

  const { event, data } = parsed.data;

  log.info({
    event: 'loveandpay.webhook.received',
    eventType: event,
    invoiceId: data.id,
    invoiceNumber: data.invoiceNumber,
    status: data.status,
  });

  try {
    if (event === 'invoice.paid') {
      const result = await processInvoicePaid({
        data,
        rawPayload: parsed.data as unknown as Record<string, unknown>,
      });
      return ok({ event, result: result.kind });
    }

    if (event === 'invoice.expired' || event === 'invoice.cancelled') {
      const reason = event === 'invoice.expired' ? 'expired' : 'cancelled';
      const result = await processInvoiceTerminal({ data, reason });
      return ok({ event, result: result.kind });
    }

    if (event === 'invoice.created') {
      log.debug({ event: 'loveandpay.webhook.created_ignored', invoiceId: data.id });
      return ok({ event, skipped: 'created_ignored' });
    }

    // Exhaustiveness — Zod discriminated union должен покрыть все варианты,
    // но если L&P пришлёт новый event, тихо игнорируем (200 OK).
    log.warn({ event: 'loveandpay.webhook.unknown_event', eventType: event });
    return ok({ skipped: 'unknown_event' });
  } catch (err) {
    log.error({
      event: 'loveandpay.webhook.unexpected_error',
      eventType: event,
      invoiceId: data.id,
      err,
    });
    Sentry.captureException(err, {
      tags: { source: 'loveandpay.webhook', eventType: event },
      extra: { invoiceId: data.id },
    });
    return ok({ skipped: 'handler_error' });
  }
}
