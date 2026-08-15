import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { findUserIdByWebSessionId, getDb, getUserTelegramId } from '@oplati/db';

import { reportPaymentProblem } from '@/lib/cabinet/actions';
import { PAYMENT_PROBLEM_TYPES } from '@/lib/cabinet/payment-issues';
import { readWebSessionId } from '@/lib/chat/session';
import { childLogger } from '@/lib/logger';
import { checkRateLimit, getClientIp } from '@/lib/ratelimit';

/**
 * POST /api/orders/problem — «Проблема с оплатой» с САЙТА (антифрод-трек,
 * тикет 10): фаза до выпуска карты, та же логика, что action `payment-problem`
 * в Mini App (общий `reportPaymentProblem`: гейт по статусу, дедуп 1 час,
 * переход «на проверку» для «я оплатил», DM оператору).
 *
 * Read-only-резолв сессии (`findUserIdByWebSessionId`): пользователя НЕ
 * создаём — жаловаться на заказ может только тот, у кого он есть.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('api.orders.problem');

const bodySchema = z.object({
  orderId: z.string().uuid(),
  problemType: z.enum(PAYMENT_PROBLEM_TYPES),
  comment: z.string().max(1000).optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  // Инвариант 9: rate-limit по IP ДО резолва сессии. Бакет общий с
  // propose/confirm — жалоба того же порядка редкости, что и заказ.
  const rl = await checkRateLimit('web-order', getClientIp(req));
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited', message: 'Слишком много запросов — попробуй через минуту.' },
      { status: 429 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 400 });
  }

  try {
    // Cookie раньше БД: запрос без сессии — заведомый 404, ходить в БД (и
    // падать в 500 при её недоступности) ему незачем.
    const webSessionId = await readWebSessionId();
    if (!webSessionId) {
      return NextResponse.json(
        { ok: false, error: 'not_found', message: 'Заказ не найден.' },
        { status: 404 },
      );
    }
    const db = getDb();
    const userId = await findUserIdByWebSessionId(db, webSessionId);
    if (!userId) {
      return NextResponse.json(
        { ok: false, error: 'not_found', message: 'Заказ не найден.' },
        { status: 404 },
      );
    }
    // telegram_id — best-effort для ссылки в DM оператору (после привязки он
    // есть и у веб-клиента); ownership проверяет сам reportPaymentProblem.
    const telegramId = await getUserTelegramId(db, userId);

    const result = await reportPaymentProblem(
      userId,
      telegramId,
      parsed.data.orderId,
      parsed.data.problemType,
      parsed.data.comment,
    );
    const status = result.ok ? 200 : result.error === 'not_found' ? 404 : 200;
    return NextResponse.json(result, { status });
  } catch (err) {
    log.error({ event: 'api.orders.problem.failed', err });
    Sentry.captureException(err, { tags: { source: 'api.orders.problem' } });
    return NextResponse.json(
      { ok: false, error: 'failed', message: 'Не получилось отправить. Попробуй ещё раз через минуту.' },
      { status: 500 },
    );
  }
}
