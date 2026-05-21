import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  createDraftOrder,
  getDb,
  getServiceById,
} from '@oplati/db';
import type { ProposeOrderResult } from '@oplati/agent';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { getLoveAndPayClient, LoveAndPayApiError } from '../loveandpay/index.ts';

/**
 * Tool `propose_order`. Считает итоговую сумму в RUB:
 *   1. Получает текущий курс USDT→RUB (`L&P /rates`).
 *   2. subtotal = round(amountUsdCents/100 * rate * 100)  // копейки RUB
 *   3. commission = round(subtotal * COMMISSION_PERCENT / 100)
 *   4. total = subtotal + commission
 *
 * Поддерживает два режима:
 *  - **Каталог:** `serviceId` указан → lookup в `services`, `requiresKyc` берётся
 *    из строки сервиса. Цена — со слов AI (`basePriceUsdCents × period`).
 *  - **Custom (вне каталога):** задан `customDescription` (свободный текст вида
 *    "iCloud+ 200GB, 6 мес") и опционально `serviceName` — заказ создаётся
 *    без FK на `services` (`serviceId IS NULL`, заполняется
 *    `customServiceDescription`). Цена со слов пользователя; оператор
 *    перепроверяет её перед оформлением (этот шаг — вне tool'а).
 *
 * XOR-валидация: должен быть задан ровно один из (`serviceId`,
 * `customDescription`); оба или ни один → throw.
 *
 * Создаёт draft order сразу в статусе `ready_for_payment` (план MVP — пропускаем
 * `clarifying`; AI сам ведёт уточнения внутри диалога до tool-call).
 *
 * Снимок курса (`usdt_rub_rate_kopecks`) и комиссии (`commission_percent`)
 * сохраняется в order — это важно для дисплея клиенту и для аудита.
 */

const log = childLogger('tool.propose_order');
const TTL_HOURS = 24;

export async function proposeOrder(input: {
  serviceId?: string;
  customDescription?: string;
  serviceName?: string;
  amountUsdCents: number;
  paymentMethod?: 'sbp' | 'card';
  userId: string;
  conversationId: string;
}): Promise<ProposeOrderResult> {
  const {
    serviceId,
    customDescription,
    serviceName,
    amountUsdCents,
    userId,
    conversationId,
  } = input;

  if (amountUsdCents <= 0) {
    throw new Error('propose_order: amountUsdCents должен быть положительным');
  }

  const hasServiceId = typeof serviceId === 'string' && serviceId.length > 0;
  const hasCustomDescription =
    typeof customDescription === 'string' && customDescription.trim().length > 0;

  if (hasServiceId && hasCustomDescription) {
    throw new Error(
      'propose_order: задайте либо serviceId, либо customDescription, не оба',
    );
  }
  if (!hasServiceId && !hasCustomDescription) {
    throw new Error(
      'propose_order: нужен serviceId (для каталога) или customDescription (для сервисов вне каталога)',
    );
  }

  const isCustom = !hasServiceId;

  log.info({
    event: 'tool.propose_order.start',
    userId,
    serviceId: serviceId ?? null,
    customDescription: customDescription ?? null,
    serviceName: serviceName ?? null,
    amountUsdCents,
    isCustom,
  });

  const db = getDb();

  let resolvedServiceId: string | null = null;
  let serviceRequiresKyc = false;

  if (hasServiceId) {
    const service = await getServiceById(db, serviceId);
    if (!service) {
      throw new Error(`propose_order: service ${serviceId} не найден`);
    }
    if (!service.isActive) {
      throw new Error(`propose_order: service ${serviceId} (${service.slug}) не активен`);
    }
    resolvedServiceId = service.id;
    serviceRequiresKyc = service.requiresKyc;
  }

  const rate = await resolveUsdtRubRate();

  const commissionPercent = serverEnv.COMMISSION_PERCENT;

  // amountUsdCents / 100 = USD. USD * rate = RUB. RUB * 100 = копейки.
  // Перемножаем как (amountUsdCents * rate) и округляем до integer (копеек).
  const subtotalKopecks = Math.round(amountUsdCents * rate);
  const commissionKopecks = Math.round((subtotalKopecks * commissionPercent) / 100);
  const totalKopecks = subtotalKopecks + commissionKopecks;

  // Сохраняем курс как `rate * 10000` (фиксированная точка с 4 знаками) в integer —
  // чтобы 95.2345 RUB/USDT хранился как 952345. Это совместимо с `usdt_rub_rate_kopecks integer`.
  const usdtRubRateKopecks = Math.round(rate * 10_000);

  const expiresAt = new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000);

  const order = await createDraftOrder(
    db,
    {
      userId,
      conversationId,
      serviceId: resolvedServiceId,
      customServiceDescription: isCustom ? customDescription : null,
      status: 'ready_for_payment',
      amountRub: totalKopecks,
      originalAmount: amountUsdCents,
      originalCurrency: 'USD',
      usdtRubRateKopecks,
      rateFixedAt: new Date(),
      expiresAt,
      commissionPercent,
      requiresKyc: serviceRequiresKyc,
      parameters: isCustom
        ? {
            extra: {
              source: 'custom',
              ...(serviceName ? { serviceName } : {}),
            },
          }
        : null,
    },
    log,
  );

  if (isCustom) {
    log.info({
      event: 'tool.propose_order.custom',
      orderId: order.id,
      shortId: order.shortId,
      customDescription,
      serviceName: serviceName ?? null,
      amountUsdCents,
      totalRubKopecks: totalKopecks,
    });
  }

  log.info({
    event: 'tool.propose_order.ok',
    orderId: order.id,
    shortId: order.shortId,
    isCustom,
    amountUsdCents,
    rate,
    subtotalKopecks,
    commissionKopecks,
    totalKopecks,
  });

  return {
    orderId: order.id,
    shortId: order.shortId,
    amountRubKopecks: subtotalKopecks,
    commissionKopecks,
    totalRubKopecks: totalKopecks,
    rateUsdRubKopecks: usdtRubRateKopecks,
    expiresAt: expiresAt.toISOString(),
    isCustom,
  };
}

/**
 * Пытается получить курс USDT/RUB через L&P `/api/v2/rates`. На любую ошибку
 * (RATE_NOT_FOUND, network, contract drift) — fallback на константу из env
 * `RATE_FALLBACK_USDT_RUB` + Sentry warning, чтобы было видно сколько заказов
 * прошло на fallback'е.
 *
 * Когда L&P зафиксирует курс — fallback перестанет срабатывать автоматически.
 */
async function resolveUsdtRubRate(): Promise<number> {
  const fallback = serverEnv.RATE_FALLBACK_USDT_RUB;
  try {
    const loveAndPay = getLoveAndPayClient();
    const ratesResp = await loveAndPay.getRates('USDT', 'RUB');
    const rate = ratesResp.rate.rate;
    if (!rate || rate <= 0) {
      throw new Error(`L&P вернул некорректный курс: ${rate}`);
    }
    log.info({ event: 'tool.propose_order.rate.live', rate });
    return rate;
  } catch (err) {
    const code = err instanceof LoveAndPayApiError ? err.code : 'unknown';
    log.warn({
      event: 'tool.propose_order.rate.fallback',
      reason: code,
      fallback,
      err,
    });
    Sentry.captureMessage('USDT/RUB rate fallback used', {
      level: 'warning',
      tags: { source: 'tool.propose_order' },
      extra: { code, fallback },
    });
    return fallback;
  }
}
