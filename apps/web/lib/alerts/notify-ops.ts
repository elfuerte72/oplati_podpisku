import 'server-only';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { sendAlert } from '../telegram/alert-bot.ts';

const log = childLogger('alerts.ops');

/**
 * Прямой ops-алерт владельцу в Telegram (`ALERT_TELEGRAM_CHAT_ID`) для критичных
 * сбоев, которые НЕЛЬЗЯ пропустить (оплаченный заказ не доехал до клиента).
 *
 * НЕ зависит от Sentry alert rules / вебхуков — отдельный, прямой канал: даже
 * если Sentry-маршрутизация не настроена, владелец узнает о провале сразу.
 *
 * `ALERT_TELEGRAM_CHAT_ID` не задан → no-op. Анти-петля: ошибку доставки только
 * логируем (НЕ `Sentry.captureException`), иначе провал алерта породил бы новый
 * Sentry-issue → снова алерт.
 */
export async function notifyOps(text: string): Promise<void> {
  const chatId = serverEnv.ALERT_TELEGRAM_CHAT_ID;
  if (!chatId) {
    log.warn({ event: 'alerts.ops.disabled', reason: 'no_chat_id' });
    return;
  }
  try {
    await sendAlert(chatId, text);
    log.info({ event: 'alerts.ops.sent' });
  } catch (err) {
    log.error({ event: 'alerts.ops.failed', err });
  }
}
