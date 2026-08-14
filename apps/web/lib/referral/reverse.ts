import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, reverseAccrualsForOrder } from '@oplati/db';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';

const log = childLogger('referral-reverse');

/**
 * Отмена реферальных начислений заказа, провалившегося ПОСЛЕ оплаты (R-1).
 *
 * Зеркало `accrueReferralForPayment`: тот начисляет на переходе в `paid`, этот
 * гасит на переходе в `failed`. Комиссия платится из маржи исполненного заказа;
 * у провалившегося маржи нет, а деньги клиенту возвращаются.
 *
 * Graceful по той же причине, что и начисление: сбой ledger'а НЕ должен сорвать
 * основной путь. Здесь цена ошибки даже выше — вызов стоит в `markOrderFailed`,
 * и проброшенное исключение оставило бы заказ в `paid`/`in_fulfillment`, то есть
 * в статусе, из которого его уже никто не заберёт. Бэкстоп на пропуски —
 * сверка в cron `referral-recovery` (T-4).
 *
 * @returns сколько строк погашено (0 — гасить было нечего или сбой)
 */
export async function reverseReferralAccrualsForFailedOrder(orderId: string): Promise<number> {
  if (!serverEnv.REFERRAL_ENABLED) return 0;

  try {
    const reversed = await reverseAccrualsForOrder(getDb(), orderId);
    if (reversed > 0) {
      log.info({ event: 'referral.reverse.applied', orderId, reversed });
    }
    return reversed;
  } catch (err) {
    log.error({ event: 'referral.reverse.failed', orderId, err });
    Sentry.captureException(err, {
      level: 'error',
      tags: { source: 'referral-reverse' },
      extra: { orderId },
    });
    return 0;
  }
}
