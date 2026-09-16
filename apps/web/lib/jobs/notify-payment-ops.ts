import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { findPaidOrderNotice, getDb, type PaidOrderNotice } from '@oplati/db';

import { type OpsFact, panelUrl } from '../alerts/format.ts';
import { notifyOps, type NotifyOpsOptions } from '../alerts/notify-ops.ts';
import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { formatKopecks, paymentProviderLabel } from '../panel/format.ts';
import { clientLabel, serviceLabel } from '../reports/daily-report.ts';

/**
 * «Оплата принята» — уведомление персоналу в тему «Платежи» ops-группы о
 * КАЖДОЙ успешной оплате: кто, что и за сколько купил (просьба владельца
 * 2026-09-16). Информационное — хвоста «Что делать» у него нет (контракт
 * `alerts/format.ts`), ссылка на заказ идёт последней строкой тела.
 *
 * Ровно одно сообщение на платёж держит не окно дедупа, а победитель
 * `claimPaymentSucceeded`: `dispatchPaymentConfirmed` зовётся только из ветки
 * `outcome.paidOk`, повтор вебхука и опрос крона сюда не доходят.
 *
 * ⚠️ Best-effort, at-most-once: факт отправки нигде не сохраняется и добора
 * нет. Умер процесс между ответом вебхука и `after()` или Telegram отказал —
 * сообщения не будет (лог `warn`), деньги и выпуск карты при этом не страдают,
 * а пропуск виден в утреннем отчёте «Отчётов». Тему нельзя читать как реестр
 * платежей — реестр это панель. Добор по `order_events` — BACKLOG.
 *
 * Никогда не бросает и денежный путь не трогает: работает из `after()` после
 * ответа вебхука, ошибка — лог + Sentry. Клиенту его копия не уходит: клиент
 * получает своё «Оплата получена» из `notifyPaymentConfirmed`.
 *
 * Подписи клиента и сервиса — те же функции, что у дневного отчёта: один заказ
 * в теме и в отчёте читается одинаково. Имя приходит из Telegram как есть,
 * текст plain — `notifyOps` шлёт без `parse_mode`, экранировать нечего.
 */

const log = childLogger('job.notify-payment-ops');

export const PAYMENT_OPS_TITLE = 'Оплата принята';

const TIME_ZONE = 'Europe/Moscow';

/** Статус к моменту чтения: `issueCard` бежит параллельно и мог уже отработать. */
const STATUS_LINES: Record<string, string> = {
  paid: 'Деньги приняты, выпуск карты ещё не начат.',
  in_fulfillment: 'Деньги приняты, заказ в выпуске карты.',
  completed: 'Деньги приняты, карта выдана.',
  failed: 'Деньги приняты, выпуск карты не удался — разбор по алёрту в теме «Авария».',
};

function mskDay(date: Date): string {
  return date.toLocaleDateString('ru-RU', { timeZone: TIME_ZONE });
}

function clientLine(client: PaidOrderNotice['client']): string {
  const label = clientLabel(client);
  return client.telegramId ? label : `${label}, сайт без Telegram`;
}

/**
 * «Сегодняшний» — по московскому календарному дню, как «новые клиенты» в
 * дневном отчёте: скользящие 24 часа спорили бы с ним у клиента, пришедшего
 * вчера вечером.
 */
function purchaseLine(client: PaidOrderNotice['client'], now: Date): string {
  const ordinal = client.purchases <= 1 ? 'первая' : `${client.purchases}-я`;
  const since = mskDay(client.since);
  return since === mskDay(now) ? `${ordinal}, клиент сегодняшний` : `${ordinal}, клиент с ${since}`;
}

function amountLine(n: PaidOrderNotice): string {
  const price = n.amountKopecks;
  const charged = n.payment.amountKopecks;
  let line = formatKopecks(charged);
  if (price != null && charged < price) {
    const sources = [
      n.promoDiscountKopecks > 0 ? 'промокод' : null,
      n.bonusDiscountKopecks > 0 ? 'баллы' : null,
    ].filter((s): s is string => s !== null);
    const label = sources.length > 0 ? sources.join(' + ') : 'скидка';
    line += ` (цена ${formatKopecks(price)}, ${label} −${formatKopecks(price - charged)})`;
  }
  if (n.cardIssueFeeKopecks > 0) line += `, в т. ч. выпуск карты ${formatKopecks(n.cardIssueFeeKopecks)}`;
  return line;
}

function providerLine(payment: PaidOrderNotice['payment']): string {
  const source = payment.recoveredViaPolling ? 'подтверждён опросом' : 'вебхук';
  return `${paymentProviderLabel(payment.provider)}, ${source}`;
}

export type PaymentOpsMessage = { body: string; options: NotifyOpsOptions };

/** Чистая сборка сообщения — тестируется без базы и без Telegram. */
export function buildPaymentOpsMessage(
  n: PaidOrderNotice,
  ctx: { now?: Date; panelHost: string | null | undefined },
): PaymentOpsMessage {
  const now = ctx.now ?? new Date();
  const facts: OpsFact[] = [
    { label: 'Заказ', value: n.shortId },
    { label: 'Клиент', value: clientLine(n.client) },
    { label: 'Покупка', value: purchaseLine(n.client, now) },
    { label: 'Что', value: serviceLabel(n) },
    { label: 'Сумма', value: amountLine(n) },
    { label: 'Провайдер', value: providerLine(n.payment) },
  ];
  const statusLine = STATUS_LINES[n.status] ?? 'Деньги приняты.';
  return {
    body: `${statusLine}\n${panelUrl(`/admin/orders/${n.shortId}`, ctx.panelHost)}`,
    options: { stream: 'payments', title: PAYMENT_OPS_TITLE, facts, preformatted: true },
  };
}

export async function notifyPaymentOps(orderId: string): Promise<void> {
  try {
    const notice = await findPaidOrderNotice(getDb(), orderId);
    if (!notice) {
      log.warn({ event: 'job.notify_payment_ops.notice_not_found', orderId });
      return;
    }
    const message = buildPaymentOpsMessage(notice, { panelHost: serverEnv.PANEL_HOST });
    const posted = await notifyOps(message.body, message.options);
    if (posted) {
      log.info({ event: 'job.notify_payment_ops.sent', orderId, shortId: notice.shortId });
    } else {
      log.warn({ event: 'job.notify_payment_ops.not_delivered', orderId, shortId: notice.shortId });
    }
  } catch (err) {
    log.error({ event: 'job.notify_payment_ops.failed', orderId, err });
    Sentry.captureException(err, { tags: { source: 'job.notify-payment-ops' }, extra: { orderId } });
  }
}
