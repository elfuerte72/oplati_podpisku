import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { getPaySpaceClient, isPaySpaceConfigured } from '@/lib/pay-space';

/**
 * Остаток на карточном счёте PaySpace — на видном месте панели (тикет 05).
 *
 * Зачем: 14 августа его нехватка уронила уже оплаченный заказ на 11 680 ₽
 * (нужно было ~$124, лежало $89.50). Пополнение приходит T+1, поэтому ценность
 * не в самом числе, а в том, чтобы увидеть его ЗАРАНЕЕ.
 *
 * ⚠️ Порог берётся из существующего места — `PAYSPACE_MIN_VCC_BALANCE_USD_CENTS`,
 * того же, что питает алёрт (`lib/jobs/vcc-balance.ts`). Второй константы не
 * заводим: разъехавшись, они означали бы, что экран и алёрт спорят о том, когда
 * бить тревогу.
 *
 * ⚠️ Никогда не бросает: недоступный провайдер — это «баланс не получен» на
 * экране, а не пятисотка вместо списка холдов.
 */

const log = childLogger('panel.vcc-balance');

export type PanelVccBalance =
  | {
      state: 'ok';
      balanceUsdCents: number;
      pendingUsdCents: number;
      /** Порог из env. `0` — алёрт выключен владельцем, подсветки нет. */
      thresholdUsdCents: number;
      low: boolean;
    }
  | { state: 'not_configured' }
  | { state: 'unavailable' };

export async function readVccBalanceForPanel(): Promise<PanelVccBalance> {
  if (!isPaySpaceConfigured()) return { state: 'not_configured' };

  const thresholdUsdCents = serverEnv.PAYSPACE_MIN_VCC_BALANCE_USD_CENTS;
  try {
    const { balanceUsdCents, pendingUsdCents } = await getPaySpaceClient().getVccBalance();
    return {
      state: 'ok',
      balanceUsdCents,
      pendingUsdCents,
      thresholdUsdCents,
      // Порог `0` означает «алёрт выключен» (решение владельца) — тогда и
      // подсвечивать нечего: любое значение формально «выше нуля».
      low: thresholdUsdCents > 0 && balanceUsdCents < thresholdUsdCents,
    };
  } catch (err) {
    // Таймаут и сетевые сбои клиент PaySpace уже нормализует; здесь важно лишь
    // не уронить страницу и оставить след для разбора.
    log.warn({ event: 'panel.vcc_balance.unavailable', err });
    Sentry.captureException(err, { tags: { source: 'panel.vcc-balance' } });
    return { state: 'unavailable' };
  }
}
