import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  appendOrderEvent,
  claimPromoSpent,
  countPromoRedemptions,
  findPromoCodeByCode,
  findPromoRedemptionByOrderId,
  getDb,
  PROMO_RELEASED_EVENT,
  releaseUnusedPromoReservation,
  reservePromoForOrder,
  type DBLike,
  type OrderRow,
  type PromoCodeRow,
} from '@oplati/db';
import { normalizePromoCode, type PromoRejectReason } from '@oplati/types';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { minAmountRubFor, primaryPaymentGateway } from '../payments/gateway.ts';
import { planPromoDiscount, type PromoDiscountPlan } from './math.ts';

/**
 * Гейты доступа и занятие промокода под заказ (трек promo-codes).
 *
 * Здесь живут ТОЛЬКО решения «можно ли и сколько», без арифметики (она в
 * `math.ts`) и без SQL (он в `@oplati/db`). Модуль зовут две точки — проверка
 * кода с экрана заказа и `payments/create`, — и обе обязаны видеть одинаковый
 * ответ: экран, который обещает скидку, а кнопка её не даёт, хуже отсутствия
 * скидки.
 */

const log = childLogger('promo');

/** Минимум счёта у АКТИВНОГО шлюза в копейках — ниже него счёт не выставится. */
function minInvoiceKopecks(): number {
  return minAmountRubFor(primaryPaymentGateway()) * 100;
}

/** Включена ли механика промокодов вообще. */
export function isPromoEnabled(): boolean {
  return serverEnv.PROMO_CODES_ENABLED;
}

export type PromoCheckResult =
  | { ok: true; plan: PromoDiscountPlan; promo: PromoCodeRow }
  | { ok: false; reason: PromoRejectReason };

/**
 * Проверить код по этому заказу и посчитать скидку — БЕЗ занятия.
 *
 * Зовут обе стороны: экран заказа (показать, что даст код) и `payments/create`
 * (посчитать то же самое перед занятием). Занятие отдельным шагом намеренно:
 * клиент, который ввёл код и передумал платить, не должен оставлять за собой
 * занятую активацию.
 *
 * ⚠️ Лимиты здесь читаются БЕЗ лока и потому носят характер подсказки: между
 * проверкой и оплатой активацию может забрать другой заказ. Настоящий барьер —
 * `reservePromoForOrder` под локами; эта функция обязана лишь не обещать того,
 * что уже заведомо нельзя.
 *
 * БРОСАЕТ при сбое чтения — как `loadBonusSpendState`. Never-throw годится
 * витрине, но не пути оплаты: проглоченная ошибка означала бы полный счёт
 * клиенту, который нажал «оплатить со скидкой».
 */
export async function checkPromoForOrder(input: {
  db?: DBLike;
  order: OrderRow;
  code: string;
}): Promise<PromoCheckResult> {
  const db = input.db ?? getDb();
  const code = normalizePromoCode(input.code);
  if (code.length === 0) return { ok: false, reason: 'not_found' };

  const promo = await findPromoCodeByCode(db, code);
  // Выключенный код и несуществующий отвечают ОДИНАКОВО: иначе перебор кодов
  // сообщал бы, какие из них существуют, и выключенная акция утекала бы раньше
  // своего запуска.
  if (!promo || !promo.isActive) {
    log.info({ event: 'promo.check.not_found', code, exists: promo !== null });
    return { ok: false, reason: 'not_found' };
  }

  const now = new Date();
  if (promo.startsAt && now < promo.startsAt) return { ok: false, reason: 'expired' };
  if (promo.expiresAt && now >= promo.expiresAt) return { ok: false, reason: 'expired' };

  const counts = await countPromoRedemptions(db, {
    promoCodeId: promo.id,
    userId: input.order.userId,
  });
  // Занятие под ЭТИМ заказом считается чужим в `countPromoRedemptions` (там нет
  // исключения по заказу) — поэтому клиент, уже применивший код к этому же
  // заказу, получил бы «already_used» на повторном открытии экрана. Смотрим на
  // свою строку отдельно и отвечаем по ней.
  const own = await findPromoRedemptionByOrderId(db, input.order.id);
  const ownIsLive = own !== null && own.status !== 'released' && own.promoCodeId === promo.id;
  if (!ownIsLive) {
    if (counts.byUser >= promo.perUserLimit) return { ok: false, reason: 'already_used' };
    if (promo.maxRedemptions !== null && counts.total >= promo.maxRedemptions) {
      return { ok: false, reason: 'exhausted' };
    }
  }

  const planned = planPromoDiscount({
    order: input.order,
    promo: {
      discountUsdCents: promo.discountUsdCents,
      capToMargin: promo.capToMargin,
      minOrderAmountKopecks: promo.minOrderAmountKopecks,
    },
    minInvoiceKopecks: minInvoiceKopecks(),
  });
  if (!planned.ok) return { ok: false, reason: planned.reason };

  return { ok: true, plan: planned.plan, promo };
}

/** То же для ВИТРИНЫ: сбой гасит блок промокода, но не ломает экран заказа. */
export async function checkPromoForOrderSafe(input: {
  order: OrderRow;
  code: string;
}): Promise<PromoCheckResult> {
  try {
    return await checkPromoForOrder(input);
  } catch (err) {
    log.error({ event: 'promo.check.failed', orderId: input.order.id, err });
    Sentry.captureException(err, { tags: { source: 'promo', step: 'check' } });
    return { ok: false, reason: 'not_found' };
  }
}

export type PromoClaimResult =
  /**
   * Скидка применена — счёт уменьшается на `plan.discountKopecks`.
   *
   * `owned` отвечает на вопрос «наше ли это занятие». `false` — строку заняла
   * ДРУГАЯ попытка того же заказа (двойной тап, вторая вкладка): скидку берём
   * из неё, но снимать её в своём `catch` нельзя — иначе проигравший освободил
   * бы промокод под уже выставленным счётом победителя, и клиент заплатил бы
   * меньше, не израсходовав активацию.
   */
  | { kind: 'claimed'; plan: PromoDiscountPlan; promoCodeId: string; owned: boolean }
  /** Механика выключена — счёт выставляем полный, молча. */
  | { kind: 'skipped' }
  /** Клиент просил скидку, а дать её нечем — отказ, а НЕ полный счёт молча. */
  | { kind: 'unavailable'; reason: PromoRejectReason };

/**
 * Занять промокод под заказ перед выставлением счёта.
 *
 * Три исхода, и разница между вторым и третьим принципиальная:
 *
 *  - `skipped` — механика выключена флагом. Тогда код от клиента ИГНОРИРУЕТСЯ:
 *    поля ввода он и не видел, а полный счёт — ровно то, чего он ждёт.
 *  - `unavailable` — клиент ввёл код, экран показал скидку, а занять не вышло
 *    (активацию забрал другой заказ, срок вышел между проверкой и оплатой).
 *    Молча выставленный полный счёт здесь был бы обманом.
 *
 * ⚠️ Занятие идёт под двумя локами (код, затем клиент), и лимиты
 * перепроверяются ВНУТРИ — расчёт снаружи мог устареть.
 */
export async function claimPromoForOrder(input: {
  order: OrderRow;
  code: string;
}): Promise<PromoClaimResult> {
  if (!isPromoEnabled()) return { kind: 'skipped' };

  let checked: PromoCheckResult;
  try {
    checked = await checkPromoForOrder(input);
  } catch (err) {
    // ⚠️ Сбой чтения — это `unavailable`, а НЕ `skipped`. Проглоченная ошибка
    // здесь означала бы счёт на полную сумму клиенту, который нажал «оплатить
    // с промокодом»: то самое молчаливое враньё, ради запрета которого и заведён
    // отдельный исход.
    log.error({ event: 'promo.claim.check_failed', orderId: input.order.id, err });
    Sentry.captureException(err, { tags: { source: 'promo', step: 'claim_check' } });
    return { kind: 'unavailable', reason: 'not_found' };
  }
  if (!checked.ok) {
    log.info({
      event: 'promo.claim.rejected',
      orderId: input.order.id,
      userId: input.order.userId,
      reason: checked.reason,
    });
    return { kind: 'unavailable', reason: checked.reason };
  }

  const reserved = await reservePromoForOrder(getDb(), {
    orderId: input.order.id,
    promoCodeId: checked.promo.id,
    userId: input.order.userId,
    discountUsdCents: checked.plan.discountUsdCents,
    discountKopecks: checked.plan.discountKopecks,
    rateKopecks: input.order.usdtRubRateKopecks ?? 0,
    perUserLimit: checked.promo.perUserLimit,
    maxRedemptions: checked.promo.maxRedemptions,
  });

  if (!reserved.ok) {
    if (reserved.reason === 'already_reserved') {
      // Не отказ: под этот заказ уже занято, просто не нами. Отдать здесь
      // `unavailable` значило бы ответить «код не сработал» на обычный двойной
      // тап — при том что счёт со скидкой как раз выставляется.
      log.info({
        event: 'promo.claim.already_reserved',
        orderId: input.order.id,
        discountKopecks: reserved.existing.discountKopecks,
      });
      return {
        kind: 'claimed',
        owned: false,
        promoCodeId: reserved.existing.promoCodeId,
        plan: {
          discountKopecks: reserved.existing.discountKopecks,
          discountUsdCents: reserved.existing.discountUsdCents,
          capped: false,
        },
      };
    }
    log.warn({
      event: 'promo.claim.unavailable',
      orderId: input.order.id,
      userId: input.order.userId,
      reason: reserved.reason,
    });
    return { kind: 'unavailable', reason: reserved.reason };
  }

  log.info({
    event: 'promo.claim.reserved',
    orderId: input.order.id,
    userId: input.order.userId,
    promoCodeId: checked.promo.id,
    discountKopecks: checked.plan.discountKopecks,
  });
  return {
    kind: 'claimed',
    owned: true,
    promoCodeId: checked.promo.id,
    plan: checked.plan,
  };
}

/**
 * Снять занятие немедленно — счёт создать не удалось.
 *
 * Never-throw по образцу `releaseBonusClaim`: этот путь проходят таймауты шлюза,
 * после которых заказ живёт дальше и клиент вернётся. Но и не молча:
 * несостоявшееся освобождение держит активацию израсходованной до протухания
 * заказа, и знать об этом по строке в логах никто не будет.
 *
 * ⚠️ Занятие под УЖЕ созданным счётом не снимается (условие внутри
 * `releaseUnusedPromoReservation`): параллельная попытка того же заказа могла
 * успеть выставить счёт со скидкой.
 */
export async function releasePromoClaim(orderId: string): Promise<void> {
  try {
    const db = getDb();
    const { applied, redemption } = await releaseUnusedPromoReservation(db, orderId);
    if (!applied || !redemption) return;
    log.info({ event: 'promo.released', orderId, discountKopecks: redemption.discountKopecks });
    await appendOrderEvent(db, {
      orderId,
      eventType: PROMO_RELEASED_EVENT,
      actorType: 'system',
      payload: {
        discountKopecks: redemption.discountKopecks,
        discountUsdCents: redemption.discountUsdCents,
        reason: 'invoice_not_created',
      },
    });
  } catch (err) {
    log.error({ event: 'promo.release_failed', orderId, err });
    Sentry.captureException(err, { tags: { source: 'promo', step: 'release' } });
  }
}

/**
 * Зафиксировать расход промокода при оплате. Зовётся ВНУТРИ транзакции
 * `processInvoicePaid`, рядом с claim платежа и переходом заказа в `paid`.
 *
 * Возвращает строку, если фиксация состоялась, — вызывающему она нужна для
 * события `order_events` в той же транзакции.
 */
export async function markPromoSpent(db: DBLike, orderId: string) {
  return await claimPromoSpent(db, orderId);
}

/**
 * Сколько скидки по промокоду РЕАЛЬНО живёт на этом заказе.
 *
 * Нужен и расчёту суммы счёта в текстах, и витрине. `0` — промокода не было или
 * его вернули.
 */
export async function promoDiscountForOrder(db: DBLike, orderId: string): Promise<number> {
  const row = await findPromoRedemptionByOrderId(db, orderId);
  return row && row.status !== 'released' ? row.discountKopecks : 0;
}
