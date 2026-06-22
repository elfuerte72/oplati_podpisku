import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { getPaySpaceClient, isPaySpaceConfigured } from '../pay-space/index.ts';

const log = childLogger('vcc-balance');

/**
 * Алёрт на низкий баланс VCC-аккаунта (фонд под выпуск карт; пополнение T+1 + fee).
 *
 * Вызывается из cron'ов `recycle-cards` (раз в сутки) И `poll-payment` (каждые
 * 5 мин). Частая проверка важна: каждая новая карта списывает `сумма+буфер+$4 fee`,
 * при потоке заказов баланс может уйти в ноль ПОСРЕДИ дня между суточными
 * прогонами recycle, а пополнение приходит только на следующий день (T+1) → каскад
 * заказов в `failed`. Чем раньше предупреждение — тем больше времени пополнить.
 *
 * Это мониторинг: ошибка проверки баланса не должна влиять на основной результат
 * cron'а (ловим и алёртим отдельно, ничего не бросаем наружу).
 */
export async function alertOnLowVccBalance(): Promise<void> {
  if (!isPaySpaceConfigured()) return;
  const threshold = serverEnv.PAYSPACE_MIN_VCC_BALANCE_USD_CENTS;
  try {
    const { balanceUsdCents } = await getPaySpaceClient().getVccBalance();
    if (balanceUsdCents < threshold) {
      log.warn({ event: 'vcc_balance.low', balanceUsdCents, threshold });
      Sentry.captureMessage('PaySpace VCC balance низкий — пополнить (T+1)', {
        level: 'warning',
        tags: { source: 'vcc-balance', alert: 'low_vcc_balance' },
        extra: { balanceUsdCents, threshold },
      });
    } else {
      log.info({ event: 'vcc_balance.ok', balanceUsdCents });
    }
  } catch (err) {
    log.error({ event: 'vcc_balance.check_error', err });
    Sentry.captureException(err, { tags: { source: 'vcc-balance', step: 'balance' } });
  }
}
