import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, getOrderById, getUserTelegramId } from '@oplati/db';

import { childLogger } from '../logger.ts';
import { getBot } from '../telegram/bot.ts';

/**
 * Уведомление пользователя в Telegram об успешной оплате.
 *
 * Срабатывает при переходе заказа в `paid` (из `processInvoicePaid` — то есть и из
 * webhook'а, и из cron `poll-payment`). Цель — дать пользователю понимание, что
 * счёт оплачен, даже если выпуск карты ещё не настроен (PaySpace) и заказ
 * остаётся в `paid` для ручного fulfillment.
 *
 * Никогда не бросает: на границе всё ловится try/catch + Sentry, чтобы не сломать
 * платёжный поток (webhook всегда 200, см. CLAUDE.md инвариант 6).
 */

const log = childLogger('job.notify-payment');

export async function notifyPaymentConfirmed(orderId: string): Promise<void> {
  try {
    const db = getDb();
    const order = await getOrderById(db, orderId);
    if (!order) {
      log.warn({ event: 'job.notify_payment.order_not_found', orderId });
      return;
    }

    const telegramId = await getUserTelegramId(db, order.userId);
    if (!telegramId) {
      // Веб-пользователь без Telegram — уведомлять нечем, это не ошибка.
      log.info({ event: 'job.notify_payment.no_telegram', orderId, shortId: order.shortId });
      return;
    }

    const amountRub = (order.amountRub ?? 0) / 100;
    const amountStr = amountRub.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

    const message = [
      `Оплата по заказу ${order.shortId} получена. Спасибо!`,
      '',
      `Сумма: ${amountStr} ₽`,
      'Мы уже обрабатываем заказ — как только всё будет готово, пришлём всё в этот чат.',
    ].join('\n');

    await getBot().api.sendMessage(Number(telegramId), message);
    log.info({ event: 'job.notify_payment.sent', orderId, shortId: order.shortId });
  } catch (err) {
    log.error({ event: 'job.notify_payment.failed', orderId, err });
    Sentry.captureException(err, {
      tags: { source: 'job.notify-payment' },
      extra: { orderId },
    });
  }
}
