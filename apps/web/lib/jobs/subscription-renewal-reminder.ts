import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  findOrdersForRenewalReminder,
  getDb,
  getServiceById,
  getUserTelegramId,
} from '@oplati/db';

import { childLogger } from '../logger.ts';
import { getBot } from '../telegram/bot.ts';

/**
 * Cron `subscription-renewal-reminder` — раз в сутки в 10:00 МСК (07:00 UTC).
 * Находит заказы со status='completed' и fulfilled_at между 23 и 26 днями назад
 * (за 4–7 дней до 30-дневного цикла) → шлёт пользователю напоминание.
 */

const log = childLogger('cron.renewal-reminder');

export async function sendRenewalReminders(): Promise<{ sent: number; errors: number }> {
  log.info({ event: 'cron.renewal_reminder.start' });

  const db = getDb();
  const orders = await findOrdersForRenewalReminder(db);

  log.info({ event: 'cron.renewal_reminder.found', count: orders.length });

  let sent = 0;
  let errors = 0;

  for (const order of orders) {
    try {
      const telegramId = await getUserTelegramId(db, order.userId);
      if (!telegramId) continue;

      let serviceName = 'подписку';
      if (order.serviceId) {
        const service = await getServiceById(db, order.serviceId);
        if (service) serviceName = service.name;
      }

      const message =
        `Через несколько дней закончится оплата ${serviceName} (заказ ${order.shortId}). ` +
        `Нужна оплата на следующий месяц? Напишите /start, продлим.`;

      await getBot().api.sendMessage(Number(telegramId), message);
      sent++;
    } catch (err) {
      errors++;
      log.error({ event: 'cron.renewal_reminder.error', orderId: order.id, err });
      Sentry.captureException(err, {
        tags: { source: 'cron.renewal-reminder' },
        extra: { orderId: order.id },
      });
    }
  }

  log.info({ event: 'cron.renewal_reminder.done', sent, errors });
  return { sent, errors };
}
