import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { saveVccBalanceSnapshot, VCC_SNAPSHOT_PROVIDER, type DBLike } from '@oplati/db';

import { childLogger } from '../logger.ts';

/**
 * Запись снимка карточного фонда — ОДНО место на обоих писателей.
 *
 * Писателей два: крон опроса баланса (штатный, каждые 5 минут) и сам гейт
 * оплаты, когда застал снимок протухшим. Держать у них по своему `try` значило
 * бы, что один и тот же сбой виден по-разному: на кроне — с алёртом, на
 * денежном пути — только строкой в логе (расхождение поймано ревью).
 *
 * Никогда не бросает: снимок — оптимизация СЛЕДУЮЩЕГО решения, а не условие
 * текущего. Ни алёрт о низком балансе, ни вердикт гейта от него не зависят.
 */

const log = childLogger('pay-space.snapshot');

export async function persistVccBalanceSnapshot(
  db: DBLike,
  input: {
    balanceUsdCents: number;
    pendingUsdCents: number;
    /**
     * Момент ОПРОСА провайдера (не записи в базу): по нему считается свежесть.
     *
     * Берём время ДО вызова, а не после ответа. Разница не всегда мала —
     * у крона дефолтный клиент ждёт до 60 с на фазу и делает два захода, — но
     * ошибается она в безопасную сторону: снимок числится старше, чем есть, и
     * протухает раньше, а не позже.
     */
    readAt: Date;
  },
  /** Кто пишет — только для логов и Sentry. */
  source: 'cron' | 'preflight',
): Promise<void> {
  try {
    await saveVccBalanceSnapshot(db, {
      provider: VCC_SNAPSHOT_PROVIDER,
      balanceUsdCents: input.balanceUsdCents,
      pendingUsdCents: input.pendingUsdCents,
      readAt: input.readAt,
    });
  } catch (err) {
    log.error({ event: 'vcc_snapshot.save_failed', source, err });
    Sentry.captureException(err, { tags: { source: 'vcc-snapshot', step: source } });
  }
}
