import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  findExpiredPendingOrders,
  getDb,
  getUserTelegramId,
  transitionOrder,
} from '@oplati/db';

import { childLogger } from '../logger.ts';
import { getBot } from '../telegram/bot.ts';

/**
 * Cron `expire-payments` — каждые 15 минут. Находит заказы в pending_payment
 * с истёкшим `expires_at` → переводит в `expired` и отправляет пользователю
 * сообщение «срок оплаты истёк».
 */

const log = childLogger('cron.expire-payments');

export async function expirePayments(): Promise<{ expired: number; errors: number }> {
  log.info({ event: 'cron.expire_payments.start' });

  const db = getDb();
  const expired = await findExpiredPendingOrders(db);

  log.info({ event: 'cron.expire_payments.found', count: expired.length });

  let errors = 0;

  for (const order of expired) {
    try {
      await transitionOrder(db, {
        orderId: order.id,
        toStatus: 'expired',
        actorType: 'system',
        eventType: 'order_expired',
        payload: { shortId: order.shortId },
      });

      const telegramId = await getUserTelegramId(db, order.userId);
      if (telegramId) {
        try {
          // telegramId — СТРОКА (не Number): большие 64-битные chat_id теряют
          // точность в double, уведомление ушло бы не тому получателю (L4).
          await getBot().api.sendMessage(
            telegramId,
            `Срок оплаты заказа ${order.shortId} истёк. Если ещё актуально — напишите /start, оформим заново.`,
          );
        } catch (err) {
          log.warn({ event: 'cron.expire_payments.notify_failed', orderId: order.id, err });
        }
      }
    } catch (err) {
      errors++;
      log.error({ event: 'cron.expire_payments.error', orderId: order.id, err });
      Sentry.captureException(err, {
        tags: { source: 'cron.expire-payments' },
        extra: { orderId: order.id },
      });
    }
  }

  log.info({ event: 'cron.expire_payments.done', expired: expired.length, errors });
  return { expired: expired.length, errors };
}
