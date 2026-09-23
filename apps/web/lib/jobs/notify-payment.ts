import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, getOrderById, getServiceById, getUserTelegramId } from '@oplati/db';

import { formatRub } from '@/components/comic/format';

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

/**
 * Текст «оплата получена» (простой текст, без разметки).
 *
 * Говорит, ЧТО придёт следом и что с этим делать (разбор пути клиента
 * 2026-09-23): прежнее «как только всё будет готово, пришлём всё в этот чат»
 * звучало как обещание готовой подписки, и клиенты ждали, что её подключат за
 * них, вместо того чтобы оплатить сервис выданной картой. Номер заказа клиенту
 * ни о чём не говорит — называем сервис.
 */
export function buildPaymentConfirmedMessage(args: {
  serviceName: string | null;
  amountKopecks: number | null;
}): string {
  const paid =
    args.amountKopecks != null
      ? `Оплата получена — ${formatRub(args.amountKopecks)}. Спасибо!`
      : 'Оплата получена. Спасибо!';
  const card = args.serviceName?.trim()
    ? `карту для ${args.serviceName.trim()}`
    : 'виртуальную карту';
  return [
    paid,
    '',
    `Сейчас выпущу ${card} и пришлю её сюда — обычно это пара минут.`,
    'Этой картой ты сам оплатишь подписку на сайте сервиса, в своём аккаунте.',
  ].join('\n');
}

/** Название сервиса для текста; сбой чтения не мешает уведомлению уйти. */
async function resolveServiceName(serviceId: string | null, orderId: string): Promise<string | null> {
  if (!serviceId) return null;
  try {
    return (await getServiceById(getDb(), serviceId))?.name ?? null;
  } catch (err) {
    log.warn({ event: 'job.notify_payment.service_lookup_failed', orderId, err });
    return null;
  }
}

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

    // У оплаченного заказа amountRub обязан быть; если его нет — не пишем
    // клиенту «Сумма: 0 ₽», а шлём уведомление без строки суммы + warning.
    if (order.amountRub == null) {
      log.warn({ event: 'job.notify_payment.missing_amount', orderId, shortId: order.shortId });
    }
    const message = buildPaymentConfirmedMessage({
      serviceName: await resolveServiceName(order.serviceId, orderId),
      amountKopecks: order.amountRub,
    });

    // telegram_id передаём строкой: Bot API принимает string chat_id, а Number()
    // терял бы точность на id за пределами безопасного диапазона JS.
    await getBot().api.sendMessage(telegramId, message);
    log.info({ event: 'job.notify_payment.sent', orderId, shortId: order.shortId });
  } catch (err) {
    log.error({ event: 'job.notify_payment.failed', orderId, err });
    Sentry.captureException(err, {
      tags: { source: 'job.notify-payment' },
      extra: { orderId },
    });
  }
}
