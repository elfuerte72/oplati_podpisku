import 'server-only';

import { getDb, getPartnerProfile, createReferralPayout } from '@oplati/db';
import {
  computePayoutFee,
  toStoredPayoutDestination,
  type PayoutDestinationInput,
} from '@oplati/types';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';

const log = childLogger('referral-payout');

export type RequestPayoutResult =
  | {
      ok: true;
      payoutId: string;
      amountUsdCents: number;
      /** Удержанная комиссия и сумма к получению (0/полная при заявке без реквизитов). */
      feeUsdCents: number;
      netUsdCents: number;
    }
  | {
      ok: false;
      error:
        | 'disabled'
        | 'telegram_link_required'
        | 'suspended'
        | 'invalid_amount'
        | 'below_minimum'
        | 'insufficient_balance';
      /** Для below_minimum/insufficient_balance — контекст для UI. */
      minPayoutUsdCents?: number;
      balanceUsdCents?: number;
    };

/**
 * Заявка на вывод реферального баланса.
 *
 * Гейты (в порядке проверки):
 *  1. Программа включена (`REFERRAL_ENABLED`).
 *  2. Личность подтверждена Telegram (баланс/выплаты требуют верифицированного
 *     юзера — как платёжный гейт чата). Передаётся из auth-слоя.
 *  3. Не заблокирован антифродом (`suspended`).
 *  4. Сумма — целое > 0, ≥ минимума, ≤ доступного баланса.
 *
 * Проверка баланса и вставка — атомарно ВНУТРИ `createReferralPayout` (per-user
 * advisory-лок, баланс вычитает выплаты requested|processing|paid в той же
 * транзакции). Поэтому две параллельные заявки не «перевыведут»: вторая ждёт
 * коммита первой и видит уменьшенный баланс. Исполнение заявки — Этап E.
 */
export async function requestReferralPayout(params: {
  userId: string;
  telegramLinked: boolean;
  amountUsdCents: number;
  /** Реквизиты (Этап E). Опциональны: заявку можно подать до формы реквизитов.
   *  Полный PAN здесь маскируется и в БД не попадает (см. toStoredPayoutDestination). */
  destination?: PayoutDestinationInput | null;
}): Promise<RequestPayoutResult> {
  const { userId, telegramLinked, amountUsdCents, destination } = params;

  if (!serverEnv.REFERRAL_ENABLED) return { ok: false, error: 'disabled' };
  if (!telegramLinked) return { ok: false, error: 'telegram_link_required' };

  if (!Number.isInteger(amountUsdCents) || amountUsdCents <= 0) {
    return { ok: false, error: 'invalid_amount' };
  }

  const minPayoutUsdCents = serverEnv.REFERRAL_MIN_PAYOUT_USD_CENTS;
  if (amountUsdCents < minPayoutUsdCents) {
    return { ok: false, error: 'below_minimum', minPayoutUsdCents };
  }

  // Комиссия вывода и маскирование реквизитов — только когда способ задан. Без
  // destination заявка создаётся с method/fee = NULL (fee 0, net = вся сумма).
  const fee = destination ? computePayoutFee(destination.method, amountUsdCents) : null;
  const storedDestination = destination ? toStoredPayoutDestination(destination) : null;
  const feeUsdCents = fee?.feeUsdCents ?? 0;
  const netUsdCents = fee?.netUsdCents ?? amountUsdCents;

  const db = getDb();

  const partner = await getPartnerProfile(db, userId);
  if (partner?.suspended) {
    log.warn({ event: 'referral.payout.suspended_blocked', userId });
    return { ok: false, error: 'suspended' };
  }

  // Баланс-чек + вставка — атомарно внутри createReferralPayout (advisory-лок на
  // userId, находка greptile P1 TOCTOU). Отдельного пред-чтения баланса нет — оно
  // было гонко-уязвимым. Неожиданные ошибки пробрасываются в catch роута (→ 500).
  const result = await createReferralPayout(
    db,
    {
      userId,
      amountUsdCents,
      method: destination?.method ?? null,
      feeUsdCents: destination ? feeUsdCents : null,
      destination: storedDestination,
    },
    log,
  );
  if (!result.ok) {
    return { ok: false, error: 'insufficient_balance', balanceUsdCents: result.balanceUsdCents };
  }
  log.info({
    event: 'referral.payout.requested',
    userId,
    amountUsdCents,
    method: destination?.method ?? null,
    payoutId: result.payoutId,
  });
  return { ok: true, payoutId: result.payoutId, amountUsdCents, feeUsdCents, netUsdCents };
}
