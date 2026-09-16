import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { findPaidOrderNotice, getDb, type PaidOrderNotice } from '@oplati/db';

import type { OpsFact } from '../alerts/format.ts';
import { notifyOps, type NotifyOpsOptions } from '../alerts/notify-ops.ts';
import { childLogger } from '../logger.ts';
import { formatKopecks, formatOriginalAmount, paymentProviderLabel } from '../panel/format.ts';

/**
 * «Оплата принята» — уведомление персоналу в тему «Платежи» ops-группы о
 * КАЖДОЙ успешной оплате: кто, что и за сколько купил (просьба владельца
 * 2026-09-16). Информационное: действий не требует, дедупа нет — ровно одно
 * сообщение на платёж держит не окно, а победитель `claimPaymentSucceeded`:
 * `dispatchPaymentConfirmed` зовётся только из ветки `outcome.paidOk`, то
 * есть повтор вебхука и опрос крона второго сообщения не дают.
 *
 * Никогда не бросает и денежный путь не трогает: работает из `after()` после
 * ответа вебхука, ошибка — лог + Sentry. Клиенту его копия не уходит: клиент
 * получает своё «Оплата получена» из `notifyPaymentConfirmed`.
 *
 * Имя клиента приходит из Telegram как есть: текст plain, без разметки —
 * `notifyOps` шлёт без `parse_mode`, экранировать нечего (та же причина, что у
 * дневного отчёта).
 */

const log = childLogger('job.notify-payment-ops');

export const PAYMENT_OPS_TITLE = 'Оплата принята';

function clientLine(client: PaidOrderNotice['client']): string {
  const name = client.displayName?.trim() || 'без имени';
  if (client.telegramUsername) return `${name} (@${client.telegramUsername})`;
  return client.telegramId ? `${name} (без username)` : `${name} (сайт, без Telegram)`;
}

function purchaseLine(client: PaidOrderNotice['client'], now: Date): string {
  const ordinal = client.purchases <= 1 ? 'первая' : `${client.purchases}-я`;
  const since = client.since.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
  const days = Math.floor((now.getTime() - client.since.getTime()) / 86_400_000);
  const age = days <= 0 ? 'клиент сегодняшний' : `клиент с ${since}`;
  return `${ordinal}, ${age}`;
}

function whatLine(n: PaidOrderNotice): string {
  const product = n.serviceName
    ? n.tierName
      ? `${n.serviceName} · ${n.tierName}`
      : n.serviceName
    : (n.customDescription?.trim() ?? '—');
  return n.originalAmount == null
    ? product
    : `${product} (${formatOriginalAmount(n.originalAmount, n.originalCurrency)})`;
}

function amountLine(n: PaidOrderNotice): string {
  const price = n.amountKopecks;
  const charged = n.payment?.amountKopecks ?? price;
  const parts: string[] = [formatKopecks(charged)];
  if (price != null && charged != null && charged < price) {
    const sources = [
      n.promoDiscountKopecks > 0 ? 'промокод' : null,
      n.bonusDiscountKopecks > 0 ? 'баллы' : null,
    ].filter((s): s is string => s !== null);
    const label = sources.length > 0 ? sources.join(' + ') : 'скидка';
    parts.push(`(цена ${formatKopecks(price)}, ${label} −${formatKopecks(price - charged)})`);
  }
  if (n.cardIssueFeeKopecks > 0) parts.push(`, в т. ч. выпуск карты ${formatKopecks(n.cardIssueFeeKopecks)}`);
  return parts.join(' ').replace(' ,', ',');
}

function providerLine(payment: PaidOrderNotice['payment']): string {
  if (!payment) return 'платёж в базе не найден';
  const source = payment.recoveredViaPolling ? 'подтверждён опросом' : 'вебхук';
  return `${paymentProviderLabel(payment.provider)}, ${source}`;
}

export type PaymentOpsMessage = { body: string; options: NotifyOpsOptions };

/** Чистая сборка сообщения — тестируется без базы и без Telegram. */
export function buildPaymentOpsMessage(n: PaidOrderNotice, now: Date = new Date()): PaymentOpsMessage {
  const facts: OpsFact[] = [
    { label: 'Заказ', value: n.shortId },
    { label: 'Клиент', value: clientLine(n.client) },
    { label: 'Покупка', value: purchaseLine(n.client, now) },
    { label: 'Что', value: whatLine(n) },
    { label: 'Сумма', value: amountLine(n) },
    { label: 'Провайдер', value: providerLine(n.payment) },
  ];
  return {
    body: 'Деньги приняты, заказ ушёл в выпуск карты.',
    options: {
      stream: 'payments',
      title: PAYMENT_OPS_TITLE,
      facts,
      action: { text: 'открыть заказ', path: `/admin/orders/${n.shortId}` },
    },
  };
}

export async function notifyPaymentOps(orderId: string): Promise<void> {
  try {
    const notice = await findPaidOrderNotice(getDb(), orderId);
    if (!notice) {
      log.warn({ event: 'job.notify_payment_ops.order_not_found', orderId });
      return;
    }
    const message = buildPaymentOpsMessage(notice);
    const posted = await notifyOps(message.body, message.options);
    log.info({ event: 'job.notify_payment_ops.sent', orderId, shortId: notice.shortId, posted });
  } catch (err) {
    log.error({ event: 'job.notify_payment_ops.failed', orderId, err });
    Sentry.captureException(err, { tags: { source: 'job.notify-payment-ops' }, extra: { orderId } });
  }
}
