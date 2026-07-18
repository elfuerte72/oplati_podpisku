import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getDb, getOrCreateUserByWebSessionId } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { checkRateLimit, getClientIp } from '@/lib/ratelimit';
import { PROVIDER_UNAVAILABLE_TEXT } from '@/lib/loveandpay/availability';
import {
  confirmOrder,
  OrderExpiredError,
  PaymentProviderUnavailableError,
  TELEGRAM_LINK_REQUIRED,
  TelegramLinkRequiredError,
} from '@/lib/tool-handlers/confirm-order';
import { getOrCreateWebSessionId } from '@/lib/chat/session';

/**
 * POST /api/orders/confirm — подтверждение заказа из веб-чата (аналог inline
 * кнопки «Подтвердить» в Telegram). Создаёт счёт через тот же `confirmOrder`,
 * что и бот.
 *
 * Ownership: в отличие от Telegram (где доверие даёт сам мессенджер), здесь
 * резолвим `userId` из cookie-сессии и передаём в `confirmOrder` — он проверит,
 * что заказ принадлежит этому пользователю (защита от чужого orderId).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 60;

const log = childLogger('web-chat-confirm');
const dbLog = childLogger('db');

const bodySchema = z.object({ orderId: z.string().uuid() });

const FAIL_TEXT =
  'Не получилось создать счёт прямо сейчас. Попробуй ещё раз или напиши «оператор».';

export async function POST(req: Request): Promise<NextResponse> {
  // Rate-limit по IP ДО резолва сессии/БД — неаутентифицированный write-эндпоинт
  // (находка security-аудита, тот же паттерн, что /api/chat и orders/propose).
  const rl = await checkRateLimit('web-order', getClientIp(req));
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited', text: 'Слишком много запросов — попробуй через минуту.' },
      { status: 429 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json', text: FAIL_TEXT }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_body', text: 'Некорректный заказ.' }, { status: 400 });
  }
  const { orderId } = parsed.data;

  let userId: string;
  try {
    const webSessionId = await getOrCreateWebSessionId();
    const user = await getOrCreateUserByWebSessionId(getDb(), { webSessionId, language: 'ru' }, dbLog);
    userId = user.id;
  } catch (err) {
    log.error({ event: 'web-chat.confirm.session_failed', err });
    Sentry.captureException(err, { tags: { source: 'web-chat.confirm' } });
    // Браузерный endpoint: клиент читает тело, статус — для мониторинга
    // (конвенция «всегда 200» относится только к webhook'ам).
    return NextResponse.json({ ok: false, error: 'unavailable', text: FAIL_TEXT }, { status: 503 });
  }

  try {
    const result = await confirmOrder({ orderId, userId });
    log.info({ event: 'web-chat.confirm.ok', orderId });
    return NextResponse.json(
      {
        ok: true,
        paymentUrl: result.paymentUrl,
        qrPayload: result.qrPayload,
        expiresAt: result.expiresAt,
      },
      { status: 200 },
    );
  } catch (err) {
    // Ожидаемый отказ, не сбой: веб-пользователь ещё не привязал Telegram —
    // клиент покажет кнопку привязки и повторит подтверждение после неё.
    if (err instanceof TelegramLinkRequiredError) {
      log.info({ event: 'web-chat.confirm.telegram_link_required', orderId });
      return NextResponse.json(
        {
          ok: false,
          error: TELEGRAM_LINK_REQUIRED,
          text: 'Чтобы оплатить, сначала привяжи Telegram — туда придёт чек и доступы по заказу.',
        },
        // 409: ожидаемый бизнес-отказ (нет привязки), не сбой — клиент рисует
        // карточку привязки по error-полю, статус различает кейс в метриках.
        { status: 409 },
      );
    }
    // Фиксация цены протухла (H-2): заказ захоронен сервером, ретрай
    // бессмысленен — зовём оформить заново по свежему курсу.
    if (err instanceof OrderExpiredError) {
      log.info({ event: 'web-chat.confirm.order_expired', orderId });
      return NextResponse.json(
        {
          ok: false,
          error: 'order_expired',
          text: 'Срок фиксации цены истёк — оформи заказ заново, сумма пересчитается по свежему курсу.',
        },
        { status: 409 },
      );
    }
    // Тех. сбой транспорта до L&P (лежит прокси / таймаут / 5xx провайдера):
    // заказ жив, честно говорим «сбой, попробуй позже» вместо generic-ошибки.
    if (err instanceof PaymentProviderUnavailableError) {
      log.error({ event: 'web-chat.confirm.provider_unavailable', orderId });
      return NextResponse.json(
        { ok: false, error: 'provider_unavailable', text: PROVIDER_UNAVAILABLE_TEXT },
        { status: 503 },
      );
    }
    log.error({ event: 'web-chat.confirm.failed', orderId, err });
    Sentry.captureException(err, { tags: { source: 'web-chat.confirm' } });
    return NextResponse.json({ ok: false, error: 'confirm_failed', text: FAIL_TEXT }, { status: 500 });
  }
}
