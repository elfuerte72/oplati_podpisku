import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { findCardsToRecycle, getDb, idleAgedActiveCards, markRecycled } from '@oplati/db';

import { childLogger } from '../logger.ts';
import { paySpaceRequestId } from '../pay-space/format.ts';
import { getPaySpaceClient, isPaySpaceConfigured } from '../pay-space/index.ts';
import { alertOnLowVccBalance } from './vcc-balance.ts';

const log = childLogger('cron.recycle-cards');

/**
 * Cron `recycle-cards` (раз в сутки):
 *  1. active + простой > 90д → idle (чистое БД-изменение).
 *  2. idle + возраст > 180д → `releaseCard` в провайдере (необратимо закрывает
 *     карту, остаток возвращается на VCC-баланс) → `markRecycled`. Пер-картно с
 *     обработкой ошибок: упавшую карту НЕ помечаем recycled — добьёт следующий
 *     запуск (at-least-once). Без ключа PaySpace шаг 2 пропускаем (закрыть карту
 *     нельзя — оставляем idle).
 *  3. Алёрт на низкий VCC-баланс (фонд под выпуск карт; пополнение T+1).
 *
 * Recycled = закрытая карта, НЕ пул для переиспользования между клиентами
 * (см. issue-card: cross-client reuse убран — release необратим, PAN не делим).
 */
export async function recycleCards(): Promise<{ idled: number; recycled: number; errors: number }> {
  log.info({ event: 'cron.recycle_cards.start' });
  const db = getDb();
  let errors = 0;
  let idled = 0;
  let recycled = 0;

  // Шаг 1: active → idle.
  try {
    idled = await idleAgedActiveCards(db, log);
  } catch (err) {
    errors++;
    log.error({ event: 'cron.recycle_cards.idle_error', err });
    Sentry.captureException(err, { tags: { source: 'cron.recycle-cards', step: 'idle' } });
  }

  // Шаг 2: idle → release → recycled.
  if (isPaySpaceConfigured()) {
    let toRecycle: Awaited<ReturnType<typeof findCardsToRecycle>> = [];
    try {
      toRecycle = await findCardsToRecycle(db);
    } catch (err) {
      errors++;
      log.error({ event: 'cron.recycle_cards.find_error', err });
      Sentry.captureException(err, { tags: { source: 'cron.recycle-cards', step: 'find' } });
    }

    if (toRecycle.length > 0) {
      const paypace = getPaySpaceClient();
      for (const card of toRecycle) {
        try {
          // Короткий request_id: длинный PaySpace молча отклоняет (см.
          // paySpaceRequestId). release-путь живьём ещё не запускался (180д),
          // лимит у него неизвестен — держим заведомо короткий ключ.
          const res = await paypace.releaseCard(
            card.providerCardId,
            paySpaceRequestId('rel', card.id),
          );
          await markRecycled(db, card.id, log);
          recycled++;
          log.info({
            event: 'cron.recycle_cards.released',
            cardId: card.id,
            releasedUsdCents: res.releasedUsdCents,
          });
        } catch (err) {
          errors++;
          // Карту НЕ помечаем recycled — добьёт следующий запуск.
          log.error({ event: 'cron.recycle_cards.release_error', cardId: card.id, err });
          Sentry.captureException(err, {
            tags: { source: 'cron.recycle-cards', step: 'release' },
            extra: { cardId: card.id },
          });
        }
      }
    }
  } else {
    log.warn({ event: 'cron.recycle_cards.skipped_no_paypace' });
  }

  // Шаг 3: алёрт на низкий VCC-баланс (не влияет на errors — это мониторинг).
  // Общий с poll-payment модуль, чтобы проверка шла и каждые 5 минут.
  await alertOnLowVccBalance();

  log.info({ event: 'cron.recycle_cards.done', idled, recycled, errors });
  return { idled, recycled, errors };
}
