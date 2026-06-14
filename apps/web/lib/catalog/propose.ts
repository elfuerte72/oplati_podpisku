import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { appendMessage, getDb, getServiceBySlug } from '@oplati/db';
import { pricingPolicy } from '@oplati/types';

import { formatRub } from '@/components/comic/format';
import { childLogger } from '@/lib/logger';
import {
  OrderAmountOutOfBoundsError,
  OrderCapExceededError,
  proposeOrder,
} from '@/lib/tool-handlers/propose-order';

/**
 * Создание заказа из каталога БЕЗ AI (решение владельца 2026-06-12) — единый
 * источник для веб-чата (`POST /api/orders/propose`) и Telegram-бота
 * (кнопочный каталог). Переиспользует серверную логику `proposeOrder` целиком:
 * границы $1–500, потолок ≤10 заказов/сутки, живой курс USDT→RUB, комиссия,
 * снимок курса в order.
 *
 * Цена тарифа берётся ТОЛЬКО из каталога на сервере (`pricing_policy`) — caller
 * присылает сумму лишь для custom-amount сервисов (Airbnb), и её всё равно
 * валидируют границы `proposeOrder`.
 *
 * Для связности диалога пишет в conversation пару сообщений (intent клиента +
 * подтверждение) — агент в последующих репликах знает о заказе, а после
 * перезагрузки/возврата след заказа виден в истории.
 */

const log = childLogger('catalog.propose');
const dbLog = childLogger('db');

export type ProposeFromCatalogInput = {
  userId: string;
  conversationId: string;
  channel: 'web' | 'telegram';
  slug: string;
  /** Для тарифных сервисов (взаимоисключающе с amountUsdCents). */
  tierName?: string;
  /** Только для custom-amount сервисов; целые USD-центы. */
  amountUsdCents?: number;
};

export type ProposeOrderCard = {
  orderId: string;
  shortId: string;
  service: string;
  totalKopecks: number;
  expiresAt: string;
  isCustom: boolean;
};

export type ProposeFromCatalogError =
  | 'service_not_found'
  | 'tier_not_found'
  | 'amount_required'
  | 'order_cap_exceeded'
  | 'amount_out_of_bounds'
  | 'propose_failed';

export type ProposeFromCatalogResult =
  | { ok: true; card: ProposeOrderCard }
  | { ok: false; error: ProposeFromCatalogError; text: string };

/**
 * Маркер «цена индивидуальная»: dummy-tier с originalAmount ≤ 1 цента (так seed
 * обходит .positive() в zod-схеме для Airbnb). Совпадает с порогом в build.ts.
 */
const CUSTOM_AMOUNT_THRESHOLD_USD_CENTS = 1;

const FAIL_TEXT: Record<ProposeFromCatalogError, string> = {
  service_not_found: 'Этот сервис сейчас недоступен. Выбери другой или напиши в чат — подключу оператора.',
  tier_not_found: 'Такого тарифа уже нет. Открой список заново или напиши в чат.',
  amount_required: 'Для этого сервиса нужна сумма в долларах. Напиши число от $1 до $500.',
  order_cap_exceeded:
    'Лимит новых заказов на сегодня исчерпан. Напиши в чат — подключу оператора.',
  amount_out_of_bounds:
    'Сумма заказа должна быть от $1 до $500. Для больших сумм напиши в чат — оформим через оператора.',
  propose_failed:
    'Не получилось создать заказ. Попробуй ещё раз или напиши в чат — подключу оператора.',
};

function fail(error: ProposeFromCatalogError): ProposeFromCatalogResult {
  return { ok: false, error, text: FAIL_TEXT[error] };
}

export async function proposeFromCatalog(
  input: ProposeFromCatalogInput,
): Promise<ProposeFromCatalogResult> {
  const { userId, conversationId, channel, slug, tierName, amountUsdCents } = input;

  try {
    const db = getDb();

    const service = await getServiceBySlug(db, slug);
    if (!service || !service.isActive) {
      return fail('service_not_found');
    }

    // Сумма — строго серверная для тарифных сервисов.
    const policy = pricingPolicy.safeParse(service.pricingPolicy);
    const tiers = policy.success ? policy.data.tiers : [];
    const isCustomAmount = tiers.every(
      (t) => (t.originalAmount ?? 0) <= CUSTOM_AMOUNT_THRESHOLD_USD_CENTS,
    );

    let orderUsdCents: number;
    let tierLabel: string | null = null;
    if (isCustomAmount) {
      if (!amountUsdCents) {
        return fail('amount_required');
      }
      orderUsdCents = amountUsdCents;
    } else {
      const tier = tiers.find(
        (t) =>
          t.name === tierName &&
          t.currency === 'USD' &&
          (t.originalAmount ?? 0) > CUSTOM_AMOUNT_THRESHOLD_USD_CENTS,
      );
      if (!tier || tier.originalAmount === undefined) {
        return fail('tier_not_found');
      }
      orderUsdCents = tier.originalAmount;
      tierLabel = `${tier.name} · ${tier.period === 'year' ? 'год' : 'месяц'}`;
    }

    const result = await proposeOrder({
      serviceId: service.id,
      amountUsdCents: orderUsdCents,
      userId,
      conversationId,
    });

    const serviceLabel = tierLabel ? `${service.name} (${tierLabel})` : service.name;

    // След в истории диалога: лучшие усилия — заказ уже создан, падение записи
    // сообщений не должно ронять результат.
    try {
      await appendMessage(
        db,
        {
          conversationId,
          role: 'user',
          content: `Хочу оплатить ${serviceLabel}`,
          meta: { channel, source: 'catalog_ui' },
        },
        dbLog,
      );
      await appendMessage(
        db,
        {
          conversationId,
          role: 'assistant',
          content: `Создал заказ №${result.shortId}: ${serviceLabel}, к оплате ${formatRub(result.totalRubKopecks)}. Подтверди оплату кнопкой в карточке заказа.`,
          meta: { channel, source: 'catalog_ui' },
        },
        dbLog,
      );
    } catch (err) {
      log.error({ event: 'catalog.propose.history_failed', orderId: result.orderId, err });
      Sentry.captureException(err, { tags: { source: 'catalog.propose', step: 'history' } });
    }

    log.info({
      event: 'catalog.propose.ok',
      channel,
      orderId: result.orderId,
      shortId: result.shortId,
      slug,
      tierName: tierName ?? null,
      amountUsdCents: orderUsdCents,
      totalKopecks: result.totalRubKopecks,
    });

    return {
      ok: true,
      card: {
        orderId: result.orderId,
        shortId: result.shortId,
        service: serviceLabel,
        totalKopecks: result.totalRubKopecks,
        expiresAt: result.expiresAt,
        isCustom: false,
      },
    };
  } catch (err) {
    if (err instanceof OrderCapExceededError) {
      log.warn({ event: 'catalog.propose.cap', channel, slug });
      return fail('order_cap_exceeded');
    }
    if (err instanceof OrderAmountOutOfBoundsError) {
      log.warn({ event: 'catalog.propose.bounds', channel, slug });
      return fail('amount_out_of_bounds');
    }
    log.error({ event: 'catalog.propose.failed', channel, slug, err });
    Sentry.captureException(err, { tags: { source: 'catalog.propose' } });
    return fail('propose_failed');
  }
}
