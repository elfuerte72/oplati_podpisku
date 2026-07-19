import 'server-only';

import { deleteOldMessages, getDb, stripOldPaymentPayloads } from '@oplati/db';

import { childLogger } from '../logger.ts';

/**
 * Cron `retention` — ежедневная чистка растущих данных (M-13 аудита; Supabase
 * free tier 500 MB). Решение владельца 2026-07-19:
 *   - `messages` (переписка) старше 90 дней — удаляются;
 *   - `payments.raw_payload` (сырое тело инвойса) старше 180 дней — очищается,
 *     сама строка платежа остаётся навсегда;
 *   - `orders` / `order_events` НЕ трогаем никогда — append-only аудит-след.
 *
 * Батчи с потолком проходов: одна ночь не обязана вычистить весь бэклог —
 * cron ежедневный, дочистит завтра (и не держит соединение/функцию бесконечно).
 */

const log = childLogger('cron.retention');

const MESSAGES_RETENTION_DAYS = 90;
const PAYLOAD_RETENTION_DAYS = 180;
const BATCH_SIZE = 500;
const MAX_BATCHES_PER_RUN = 20;

export async function runRetention(): Promise<{ messagesDeleted: number; payloadsStripped: number }> {
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

  log.info({ event: 'cron.retention.done', messagesDeleted, payloadsStripped });
  return { messagesDeleted, payloadsStripped };
}
