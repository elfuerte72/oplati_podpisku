import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  appendMessage,
  getDb,
  getOrCreateActiveConversation,
  getOrCreateUserByWebSessionId,
  getServiceBySlug,
} from '@oplati/db';
import { pricingPolicy } from '@oplati/types';

import { formatRub } from '@/components/comic/format';
import { childLogger } from '@/lib/logger';
import { getOrCreateWebSessionId } from '@/lib/chat/session';
import {
  OrderAmountOutOfBoundsError,
  OrderCapExceededError,
  proposeOrder,
} from '@/lib/tool-handlers/propose-order';

/**
 * POST /api/orders/propose — кнопочный флоу веб-чата (сервис → тариф → заказ)
 * БЕЗ вызова AI (решение владельца 2026-06-12). Переиспользует серверную
 * логику propose_order целиком: границы $1–500, потолок ≤10 заказов/сутки,
 * живой курс USDT→RUB, комиссия, снимок курса в order.
 *
 * Цена тарифа берётся ТОЛЬКО из каталога на сервере (pricing_policy) — клиент
 * присылает сумму лишь для custom-amount сервисов (Airbnb), и её всё равно
 * валидируют границы proposeOrder.
 *
 * Для связности диалога пишет в conversation пару сообщений (intent клиента +
 * подтверждение) — агент в последующих репликах знает о заказе, а после
 * перезагрузки страницы след заказа виден в истории.
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
    // Только для custom-amount сервисов; целые USD-центы.
    amountUsdCents: z.number().int().positive().optional(),
  })
  .refine((b) => (b.tierName ? !b.amountUsdCents : true), {
    message: 'tierName и amountUsdCents взаимоисключающие',
  });

const GENERIC_FAIL_TEXT =
  'Не получилось создать заказ. Попробуйте ещё раз или напишите в чат — подключу оператора.';

export async function POST(req: Request): Promise<NextResponse> {
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
  const { slug, tierName, amountUsdCents } = parsed.data;

  try {
    const db = getDb();

    const service = await getServiceBySlug(db, slug);
    if (!service || !service.isActive) {
      return NextResponse.json({ ok: false, error: 'service_not_found' }, { status: 404 });
    }

    // Сумма — строго серверная для тарифных сервисов.
    const policy = pricingPolicy.safeParse(service.pricingPolicy);
    const tiers = policy.success ? policy.data.tiers : [];
    const isCustomAmount = tiers.every((t) => (t.originalAmount ?? 0) <= 1);

    let orderUsdCents: number;
    let tierLabel: string | null = null;
    if (isCustomAmount) {
      if (!amountUsdCents) {
        return NextResponse.json({ ok: false, error: 'amount_required' }, { status: 400 });
      }
      orderUsdCents = amountUsdCents;
    } else {
      const tier = tiers.find(
        (t) => t.name === tierName && t.currency === 'USD' && (t.originalAmount ?? 0) > 1,
      );
      if (!tier || tier.originalAmount === undefined) {
        return NextResponse.json({ ok: false, error: 'tier_not_found' }, { status: 404 });
      }
      orderUsdCents = tier.originalAmount;
      tierLabel = `${tier.name} · ${tier.period === 'year' ? 'год' : 'месяц'}`;
    }

    const webSessionId = await getOrCreateWebSessionId();
    const user = await getOrCreateUserByWebSessionId(db, { webSessionId, language: 'ru' }, dbLog);
    const conversation = await getOrCreateActiveConversation(
      db,
      { userId: user.id, channel: 'web' },
      dbLog,
    );

    const result = await proposeOrder({
      serviceId: service.id,
      amountUsdCents: orderUsdCents,
      userId: user.id,
      conversationId: conversation.id,
    });

    const serviceLabel = tierLabel ? `${service.name} (${tierLabel})` : service.name;

    // След в истории диалога: лучшие усилия — заказ уже создан, падение
    // записи сообщений не должно ронять ответ.
    try {
      await appendMessage(
        getDb(),
        {
          conversationId: conversation.id,
          role: 'user',
          content: `Хочу оплатить ${serviceLabel}`,
          meta: { channel: 'web', source: 'catalog_ui' },
        },
        dbLog,
      );
      await appendMessage(
        getDb(),
        {
          conversationId: conversation.id,
          role: 'assistant',
          content: `Создал заказ №${result.shortId}: ${serviceLabel}, к оплате ${formatRub(result.totalRubKopecks)}. Подтверди оплату кнопкой в карточке заказа.`,
          meta: { channel: 'web', source: 'catalog_ui' },
        },
        dbLog,
      );
    } catch (err) {
      log.error({ event: 'api.orders.propose.history_failed', orderId: result.orderId, err });
      Sentry.captureException(err, { tags: { source: 'api.orders.propose', step: 'history' } });
    }

    log.info({
      event: 'api.orders.propose.ok',
      orderId: result.orderId,
      shortId: result.shortId,
      slug,
      tierName: tierName ?? null,
      amountUsdCents: orderUsdCents,
      totalKopecks: result.totalRubKopecks,
    });

    return NextResponse.json(
      {
        ok: true,
        card: {
          orderId: result.orderId,
          shortId: result.shortId,
          service: serviceLabel,
          totalKopecks: result.totalRubKopecks,
          expiresAt: result.expiresAt,
          isCustom: false,
        },
      },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof OrderCapExceededError) {
      log.warn({ event: 'api.orders.propose.cap', slug });
      return NextResponse.json(
        {
          ok: false,
          error: 'order_cap_exceeded',
          text: 'Лимит новых заказов на сегодня исчерпан. Напишите в чат — подключу оператора.',
        },
        { status: 429 },
      );
    }
    if (err instanceof OrderAmountOutOfBoundsError) {
      log.warn({ event: 'api.orders.propose.bounds', slug });
      return NextResponse.json(
        {
          ok: false,
          error: 'amount_out_of_bounds',
          text: 'Сумма заказа должна быть от $1 до $500. Для больших сумм напишите в чат — оформим через оператора.',
        },
        { status: 400 },
      );
    }
    log.error({ event: 'api.orders.propose.failed', slug, err });
    Sentry.captureException(err, { tags: { source: 'api.orders.propose' } });
    return NextResponse.json(
      { ok: false, error: 'propose_failed', text: GENERIC_FAIL_TEXT },
      { status: 500 },
    );
  }
}
