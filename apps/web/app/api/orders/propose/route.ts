import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  getDb,
  getOrCreateActiveConversation,
  getOrCreateUserByWebSessionId,
} from '@oplati/db';

import { proposeFromCatalog, type ProposeFromCatalogError } from '@/lib/catalog/propose';
import { childLogger } from '@/lib/logger';
import { checkRateLimit, getClientIp } from '@/lib/ratelimit';
import { rememberClientIp } from '@/lib/contacts/track-ip';
import { getOrCreateWebSessionId } from '@/lib/chat/session';

/**
 * POST /api/orders/propose — кнопочный флоу веб-чата (сервис → тариф → заказ)
 * БЕЗ вызова AI (решение владельца 2026-06-12). Тонкий адаптер: резолвит
 * веб-пользователя по cookie-сессии и делегирует создание заказа общему
 * хелперу `proposeFromCatalog` (тот же, что использует Telegram-бот).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('api.orders.propose');
const dbLog = childLogger('db');

const bodySchema = z
  .object({
    slug: z.string().trim().min(1).max(100),
    tierName: z.string().trim().min(1).max(100).optional(),
    tierPeriod: z.enum(['month', 'quarter', 'year']).optional(),
    // Только для custom-amount сервисов; целые USD-центы.
    amountUsdCents: z.number().int().positive().optional(),
  })
  .refine((b) => (b.tierName ? !b.amountUsdCents : true), {
    message: 'tierName и amountUsdCents взаимоисключающие',
  });

/** HTTP-статус по типу доменной ошибки proposeFromCatalog. */
const ERROR_STATUS: Record<ProposeFromCatalogError, number> = {
  service_not_found: 404,
  // Битая pricing_policy — проблема наших данных, не клиента (M-7).
  service_unavailable: 503,
  tier_not_found: 404,
  amount_required: 400,
  order_cap_exceeded: 429,
  amount_out_of_bounds: 400,
  below_min: 400,
  propose_failed: 500,
};

export async function POST(req: Request): Promise<NextResponse> {
  // Rate-limit по IP ДО резолва сессии и любых записей в БД (находка
  // security-аудита): без него скриптовый клиент без cookie получал свежую
  // сессию — и свежий суточный кап — на каждый запрос, т.е. неограниченный
  // рост users/conversations/orders.
  const rl = await checkRateLimit('web-order', getClientIp(req));
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited', text: 'Слишком много запросов — попробуйте через минуту.' },
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
  const { slug, tierName, tierPeriod, amountUsdCents } = parsed.data;

  try {
    const db = getDb();
    const webSessionId = await getOrCreateWebSessionId();
    const user = await getOrCreateUserByWebSessionId(db, { webSessionId, language: 'ru' }, dbLog);
    // Антифрод-трек (тикет 01): создание заказа — живой запрос клиента,
    // запоминаем его адрес для будущего счёта Freekassa.
    await rememberClientIp(req, user.id);
    const conversation = await getOrCreateActiveConversation(
      db,
      { userId: user.id, channel: 'web' },
      dbLog,
    );

    const result = await proposeFromCatalog({
      userId: user.id,
      conversationId: conversation.id,
      channel: 'web',
      slug,
      tierName,
      tierPeriod,
      amountUsdCents,
    });

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error, text: result.text },
        { status: ERROR_STATUS[result.error] },
      );
    }

    log.info({ event: 'api.orders.propose.ok', orderId: result.card.orderId, slug });
    return NextResponse.json({ ok: true, card: result.card }, { status: 200 });
  } catch (err) {
    log.error({ event: 'api.orders.propose.failed', slug, err });
    Sentry.captureException(err, { tags: { source: 'api.orders.propose' } });
    return NextResponse.json(
      {
        ok: false,
        error: 'propose_failed',
        text: 'Не получилось создать заказ. Попробуйте ещё раз или напишите в чат — подключу оператора.',
      },
      { status: 500 },
    );
  }
}
