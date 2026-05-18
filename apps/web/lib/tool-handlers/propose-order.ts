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
 * Создаёт draft order сразу в статусе `ready_for_payment` (план MVP — пропускаем
 * `clarifying`; AI сам ведёт уточнения внутри диалога до tool-call).
 *
 * Снимок курса (`usdt_rub_rate_kopecks`) и комиссии (`commission_percent`)
 * сохраняется в order — это важно для дисплея клиенту и для аудита.
 */

const log = childLogger('tool.propose_order');
const TTL_HOURS = 24;

export async function proposeOrder(input: {
  serviceId: string;
  amountUsdCents: number;
  paymentMethod?: 'sbp' | 'card';
  userId: string;
  conversationId: string;
}): Promise<ProposeOrderResult> {
  const { serviceId, amountUsdCents, userId, conversationId } = input;

  if (amountUsdCents <= 0) {
    throw new Error('propose_order: amountUsdCents должен быть положительным');
  }

  log.info({
    event: 'tool.propose_order.start',
    userId,
    serviceId,
    amountUsdCents,
  });

  const db = getDb();

  const service = await getServiceById(db, serviceId);
  if (!service) {
    throw new Error(`propose_order: service ${serviceId} не найден`);
  }
  if (!service.isActive) {
    throw new Error(`propose_order: service ${serviceId} (${service.slug}) не активен`);
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
      serviceId,
      status: 'ready_for_payment',
      amountRub: totalKopecks,
      originalAmount: amountUsdCents,
      originalCurrency: 'USD',
      usdtRubRateKopecks,
      rateFixedAt: new Date(),
      expiresAt,
      commissionPercent,
      requiresKyc: service.requiresKyc,
    },
    log,
  );

  log.info({
    event: 'tool.propose_order.ok',
    orderId: order.id,
    shortId: order.shortId,
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
