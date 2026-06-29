import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  getDb,
  getPartnerProfile,
  getReferralBalanceUsdCents,
  createReferralPayout,
} from '@oplati/db';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';

const log = childLogger('referral-payout');

export type RequestPayoutResult =
  | { ok: true; payoutId: string; amountUsdCents: number }
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
 * Баланс берётся `getReferralBalanceUsdCents`, который УЖЕ вычитает выплаты в
 * статусах requested|processing|paid — поэтому две параллельные заявки не
 * «перевыведут»: вторая увидит уменьшенный баланс. Исполнение заявки — Этап E.
 */
export async function requestReferralPayout(params: {
  userId: string;
  telegramLinked: boolean;
  amountUsdCents: number;
}): Promise<RequestPayoutResult> {
  const { userId, telegramLinked, amountUsdCents } = params;

  if (!serverEnv.REFERRAL_ENABLED) return { ok: false, error: 'disabled' };
  if (!telegramLinked) return { ok: false, error: 'telegram_link_required' };

  if (!Number.isInteger(amountUsdCents) || amountUsdCents <= 0) {
    return { ok: false, error: 'invalid_amount' };
  }

  const minPayoutUsdCents = serverEnv.REFERRAL_MIN_PAYOUT_USD_CENTS;
  if (amountUsdCents < minPayoutUsdCents) {
    return { ok: false, error: 'below_minimum', minPayoutUsdCents };
  }

  const db = getDb();

  const partner = await getPartnerProfile(db, userId);
  if (partner?.suspended) {
    log.warn({ event: 'referral.payout.suspended_blocked', userId });
    return { ok: false, error: 'suspended' };
  }

  const balanceUsdCents = await getReferralBalanceUsdCents(db, userId);
  if (amountUsdCents > balanceUsdCents) {
    return { ok: false, error: 'insufficient_balance', balanceUsdCents };
  }

  try {
    const payoutId = await createReferralPayout(db, { userId, amountUsdCents }, log);
    log.info({ event: 'referral.payout.requested', userId, amountUsdCents, payoutId });
    return { ok: true, payoutId, amountUsdCents };
  } catch (err) {
    log.error({ event: 'referral.payout.failed', userId, err });
    Sentry.captureException(err, { tags: { source: 'referral.payout' } });
    return { ok: false, error: 'insufficient_balance', balanceUsdCents };
  }
}
