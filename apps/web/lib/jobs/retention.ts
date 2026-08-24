import 'server-only';

import {
  deleteExpiredCardFundReservations,
  deleteOldAnalyticsEvents,
  deleteOldMessages,
  getDb,
  stripOldPaymentPayloads,
  syncAnalyticsDictionary,
} from '@oplati/db';
import { analyticsDictionaryRows } from '@oplati/types';

import { childLogger } from '../logger.ts';
import {
  ANALYTICS_RETENTION_DAYS,
  MESSAGES_RETENTION_DAYS,
  PAYLOAD_RETENTION_DAYS,
} from '../retention-policy.ts';

/**
 * Cron `retention` — ежедневная чистка растущих данных (M-13 аудита; Supabase
 * free tier 500 MB). Решение владельца 2026-07-19:
 *   - `messages` (переписка) старше 90 дней — удаляются;
 *   - `payments.raw_payload` (сырое тело инвойса) старше 180 дней — очищается,
 *     сама строка платежа остаётся навсегда;
 *   - `orders` / `order_events` НЕ трогаем никогда — append-only аудит-след;
 *   - `analytics_events` старше 400 дней — удаляются (год сравнений плюс запас;
 *     DELETE в этой таблице разрешён, в отличие от аудита денег).
 *
 * Здесь же — синхронизация словаря событий из кода в `analytics_event_types`.
 * Не миграцией: миграции применяются вручную ПОСЛЕ деплоя, и подписи в отчётах
 * не должны зависеть от того, выполнил ли кто-то этот шаг. Идемпотентный
 * upsert, самовосстанавливается на следующем прогоне.
 *
 * Батчи с потолком проходов: одна ночь не обязана вычистить весь бэклог —
 * cron ежедневный, дочистит завтра (и не держит соединение/функцию бесконечно).
 */

const log = childLogger('cron.retention');

// Сроки — из общего модуля: их читает и панель поддержки, объясняя обрыв ленты.

const BATCH_SIZE = 500;
const MAX_BATCHES_PER_RUN = 20;

/**
 * Сколько держать протухшие занятия карточного фонда. Срок счёта — час, так что
 * неделя это заведомый запас: след для разбора инцидента остаётся, а таблица,
 * которую читают под глобальным замком, не растёт бесконечно.
 */
const FUND_RESERVATION_RETENTION_DAYS = 7;

export async function runRetention(): Promise<{
  messagesDeleted: number;
  payloadsStripped: number;
  analyticsDeleted: number;
  dictionarySynced: number;
  fundReservationsDeleted: number;
}> {
  log.info({ event: 'cron.retention.start' });
  const db = getDb();

  let messagesDeleted = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const deleted = await deleteOldMessages(
      db,
      { olderThanDays: MESSAGES_RETENTION_DAYS, limit: BATCH_SIZE },
      log,
    );
    messagesDeleted += deleted;
    if (deleted < BATCH_SIZE) break;
  }

  let payloadsStripped = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const stripped = await stripOldPaymentPayloads(
      db,
      { olderThanDays: PAYLOAD_RETENTION_DAYS, limit: BATCH_SIZE },
      log,
    );
    payloadsStripped += stripped;
    if (stripped < BATCH_SIZE) break;
  }

  // Отдельный try: пока миграция 0028 не применена на боевой БД (а применяется
  // она вручную ПОСЛЕ деплоя), таблицы ещё нет — и падение здесь унесло бы
  // с собой весь джоб, включая уже выполненную чистку переписки и payload'ов.
  let analyticsDeleted = 0;
  try {
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const deleted = await deleteOldAnalyticsEvents(
        db,
        { olderThanDays: ANALYTICS_RETENTION_DAYS, limit: BATCH_SIZE },
        log,
      );
      analyticsDeleted += deleted;
      if (deleted < BATCH_SIZE) break;
    }
  } catch (err) {
    log.error({ event: 'cron.retention.analytics_failed', err });
  }

  // Отдельный try по той же причине, что у аналитики: миграция 0040
  // применяется вручную, и до неё таблицы нет — падение здесь унесло бы уже
  // выполненную чистку переписки и payload'ов.
  let fundReservationsDeleted = 0;
  try {
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const deleted = await deleteExpiredCardFundReservations(db, {
        olderThanDays: FUND_RESERVATION_RETENTION_DAYS,
        limit: BATCH_SIZE,
      });
      fundReservationsDeleted += deleted;
      if (deleted < BATCH_SIZE) break;
    }
  } catch (err) {
    log.error({ event: 'cron.retention.fund_reservations_failed', err });
  }

  // Словарь синхронизируем последним и не роняем им весь джоб: чистка данных
  // важнее подписей в отчёте.
  let dictionarySynced = 0;
  try {
    dictionarySynced = await syncAnalyticsDictionary(db, analyticsDictionaryRows());
  } catch (err) {
    log.error({ event: 'cron.retention.dictionary_failed', err });
  }

  log.info({
    event: 'cron.retention.done',
    messagesDeleted,
    payloadsStripped,
    analyticsDeleted,
    dictionarySynced,
    fundReservationsDeleted,
  });
  return {
    messagesDeleted,
    payloadsStripped,
    analyticsDeleted,
    dictionarySynced,
    fundReservationsDeleted,
  };
}
