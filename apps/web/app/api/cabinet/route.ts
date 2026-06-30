import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { childLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/ratelimit';
import { resolveCabinetUser } from '@/lib/cabinet/auth';
import { buildOrderDetail, buildSnapshot } from '@/lib/cabinet/read';
import { payOrder, repeatOrder, requestOperator } from '@/lib/cabinet/actions';
import { getCardSecretsForUser } from '@/lib/cabinet/card-secrets';

/**
 * POST /api/cabinet — бэкенд личного кабинета Telegram Mini App.
 *
 * Контракт: тело `{ action, initData, ... }`. `initData` (подпись Telegram)
 * проверяется на КАЖДЫЙ запрос — это единственная авторизация кабинета
 * (см. lib/cabinet/auth.ts). После валидации — per-identity rate-limit по
 * telegram_id, затем диспатч действия.
 *
 * Это НЕ webhook (вызывает наш же клиент), поэтому отвечаем настоящими
 * статус-кодами: 401 — плохая/протухшая подпись, 429 — rate-limit, 404 —
 * чужой/несуществующий заказ, 200 — успех (или ожидаемая ошибка действия в теле).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 60;

const log = childLogger('cabinet-api');

const orderAction = z.object({ initData: z.string().min(1), orderId: z.string().uuid() });
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshot'), initData: z.string().min(1) }),
  orderAction.extend({ action: z.literal('order') }),
  orderAction.extend({ action: z.literal('pay') }),
  orderAction.extend({ action: z.literal('repeat') }),
  orderAction.extend({ action: z.literal('operator') }),
  z.object({
    action: z.literal('card-details'),
    initData: z.string().min(1),
    cardId: z.string().uuid(),
  }),
]);

const RATE_LIMITED_TEXT = 'Слишком много запросов подряд. Подожди минутку и попробуй снова.';

export async function POST(req: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 400 });
  }
  const body = parsed.data;

  // 1. Авторизация: проверка подписи initData + резолв userId.
  const auth = await resolveCabinetUser(body.initData);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const { userId, telegramId } = auth.user;

  // 2. Per-identity rate-limit по telegram_id (как в боте). Fail-open без Upstash.
  const rl = await checkRateLimit('telegram', telegramId);
  if (!rl.allowed) {
    log.warn({ event: 'cabinet.rate_limited', action: body.action });
    return NextResponse.json(
      { ok: false, error: 'rate_limited', text: RATE_LIMITED_TEXT },
      { status: 429 },
    );
  }

  // 3. Диспатч действия.
  try {
    switch (body.action) {
      case 'snapshot': {
        const snapshot = await buildSnapshot(userId);
        return NextResponse.json({ ok: true, ...snapshot }, { status: 200 });
      }
      case 'order': {
        const detail = await buildOrderDetail(userId, body.orderId);
        if (!detail) {
          return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
        }
        return NextResponse.json({ ok: true, order: detail }, { status: 200 });
      }
      case 'pay': {
        const result = await payOrder(userId, body.orderId);
        const status = result.ok ? 200 : result.error === 'not_found' ? 404 : 200;
        return NextResponse.json(result, { status });
      }
      case 'repeat': {
        const result = await repeatOrder(userId, body.orderId);
        const status = result.ok ? 200 : result.error === 'not_found' ? 404 : 200;
        return NextResponse.json(result, { status });
      }
      case 'operator': {
        const result = await requestOperator(userId, body.orderId);
        const status = result.ok ? 200 : result.error === 'not_found' ? 404 : 200;
        return NextResponse.json(result, { status });
      }
      case 'card-details': {
        // Разовый показ реквизитов: live-fetch из PaySpace, в БД не хранятся.
        // no-store — ответ с реквизитами не должен кэшироваться нигде по пути.
        const result = await getCardSecretsForUser(userId, body.cardId);
        const status = result.ok ? 200 : result.error === 'not_found' ? 404 : 200;
        return NextResponse.json(result, { status, headers: { 'cache-control': 'no-store' } });
      }
    }
  } catch (err) {
    log.error({ event: 'cabinet.dispatch.failed', action: body.action, err });
    Sentry.captureException(err, { tags: { source: 'cabinet-api', action: body.action } });
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
