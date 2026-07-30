import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { appendMessage, getDb, getServiceBySlug } from '@oplati/db';
import { pricingPolicy } from '@oplati/types';

import { formatRub } from '@/components/comic/format';
import { childLogger } from '@/lib/logger';
import {
  currentBuyerFeePercent,
  minAmountRubFor,
  primaryPaymentGateway,
} from '@/lib/payments/gateway';
import { MIN_AMOUNT_USD, maxAmountUsdFor } from '@/lib/telegram/amount';
import {
  OrderAmountOutOfBoundsError,
  OrderBelowMinimumError,
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
  tierPeriod?: 'month' | 'quarter' | 'year';
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
  /**
   * Надбавка платёжной системы на плательщика в процентах (0 — её нет).
   * Считается на сервере по текущему шлюзу и едет вместе с картой заказа:
   * предупреждение о ней должно быть на том же экране, где кнопка «Оплатить».
   */
  buyerFeePercent: number;
};

export type ProposeFromCatalogError =
  | 'service_not_found'
  | 'service_unavailable'
  | 'tier_not_found'
  | 'amount_required'
  | 'order_cap_exceeded'
  | 'amount_out_of_bounds'
  | 'below_min'
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
  service_unavailable:
    'Этот сервис временно недоступен. Выбери другой или напиши в чат — подключу оператора.',
  tier_not_found: 'Такого тарифа уже нет. Открой список заново или напиши в чат.',
  // ⚠️ Границы НЕ зашивать: потолок зависит от сервиса ($1200 у пополнений
  // против $500 у остальных), а пол — от env активного шлюза. Зашитые «до $500»
  // и «500 ₽» врали клиенту, как только значения разошлись (аудит 2026-07-28).
  amount_required: 'Для этого сервиса нужна сумма в долларах — напиши число.',
  order_cap_exceeded:
    'Лимит новых заказов на сегодня исчерпан. Напиши в чат — подключу оператора.',
  // Оба текста подставляются динамически (см. `boundsText`/`belowMinText`);
  // строки здесь — фоллбэк, если лимит по какой-то причине неизвестен.
  amount_out_of_bounds:
    'Сумма заказа вне допустимых границ. Для больших сумм напиши в чат — оформим через оператора.',
  below_min:
    'Сумма заказа ниже минимума платёжной системы. Выбери тариф подороже или оплати сразу несколько подписок. Нужна именно эта сумма — напиши в чат, подключу оператора.',
  propose_failed:
    'Не получилось создать заказ. Попробуй ещё раз или напиши в чат — подключу оператора.',
};

function fail(error: ProposeFromCatalogError): ProposeFromCatalogResult {
  return { ok: false, error, text: FAIL_TEXT[error] };
}

export async function proposeFromCatalog(
  input: ProposeFromCatalogInput,
): Promise<ProposeFromCatalogResult> {
  const { userId, conversationId, channel, slug, tierName, tierPeriod, amountUsdCents } = input;

  try {
    const db = getDb();

    const service = await getServiceBySlug(db, slug);
    if (!service || !service.isActive) {
      return fail('service_not_found');
    }

    // Сумма — строго серверная для тарифных сервисов. Битая политика — отказ,
    // как в build.ts (M-7 аудита): раньше tiers=[] превращали every() в true,
    // сервис становился «custom-amount» и принимал цену клиента.
    const policy = pricingPolicy.safeParse(service.pricingPolicy);
    if (!policy.success) {
      log.error({ event: 'catalog.propose.broken_policy', slug });
      Sentry.captureMessage('catalog.propose: битая pricing_policy', {
        level: 'error',
        tags: { source: 'catalog.propose' },
        extra: { slug },
      });
      return fail('service_unavailable');
    }
    // Схема гарантирует ≥1 тариф — custom-amount только если политика ЯВНО
    // из одних dummy-тарифов (маркер seed для Airbnb).
    const tiers = policy.data.tiers;
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
          (!tierPeriod || t.period === tierPeriod) &&
          t.currency === 'USD' &&
          (t.originalAmount ?? 0) > CUSTOM_AMOUNT_THRESHOLD_USD_CENTS,
      );
      if (!tier || tier.originalAmount === undefined) {
        return fail('tier_not_found');
      }
      orderUsdCents = tier.originalAmount;
      tierLabel = `${tier.name} · ${formatTierPeriod(tier.period)}`;
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
      tierPeriod: tierPeriod ?? null,
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
        buyerFeePercent: currentBuyerFeePercent(),
      },
    };
  } catch (err) {
    if (err instanceof OrderCapExceededError) {
      log.warn({ event: 'catalog.propose.cap', channel, slug });
      return fail('order_cap_exceeded');
    }
    if (err instanceof OrderAmountOutOfBoundsError) {
      log.warn({ event: 'catalog.propose.bounds', channel, slug });
      return {
        ok: false,
        error: 'amount_out_of_bounds',
        text: `Сумма заказа должна быть от $${MIN_AMOUNT_USD} до $${maxAmountUsdFor(slug)}. Для больших сумм напиши в чат — оформим через оператора.`,
      };
    }
    if (err instanceof OrderBelowMinimumError) {
      log.warn({ event: 'catalog.propose.below_min', channel, slug });
      return {
        ok: false,
        error: 'below_min',
        text: `Минимальная сумма заказа — ${minAmountRubFor(primaryPaymentGateway())} ₽ (ограничение оплаты). Выбери тариф подороже или оплати сразу несколько подписок. Нужна именно эта сумма — напиши в чат, подключу оператора.`,
      };
    }
    log.error({ event: 'catalog.propose.failed', channel, slug, err });
    Sentry.captureException(err, { tags: { source: 'catalog.propose' } });
    return fail('propose_failed');
  }
}

function formatTierPeriod(period: 'month' | 'quarter' | 'year'): string {
  if (period === 'year') return 'год';
  if (period === 'quarter') return '3 месяца';
  return 'месяц';
}
