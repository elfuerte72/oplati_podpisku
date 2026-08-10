import 'server-only';

import * as Sentry from '@sentry/nextjs';

import type { PaymentRow } from '@oplati/db';
import { freekassaTerminalReason, FREEKASSA_ORDER_STATUS } from '@oplati/types';

import { childLogger } from '../logger.ts';
import { getFreekassaClient, isFreekassaConfigured } from '../freekassa/index.ts';
import { processFreekassaPaid, processFreekassaTerminal } from '../freekassa/handlers.ts';
import { getLoveAndPayClient, isLoveAndPayConfigured } from '../loveandpay/index.ts';
import {
  loveAndPayTerminalReason,
  processInvoicePaid,
  processInvoiceTerminal,
} from '../loveandpay/handlers.ts';

/**
 * Опрос ОДНОГО pending-платежа у его шлюза — общий примитив двух cron'ов.
 *
 * Живёт отдельным модулем, потому что потребителей два и природа у них разная:
 *   - `poll-payment` (каждые 5 мин) — страховка от потерянных уведомлений;
 *   - `expire-payments` (каждые 15 мин) — ФИНАЛЬНАЯ сверка перед захоронением
 *     счёта. Без неё оплата на последних минутах TTL при потерянном вебхуке
 *     терялась молча: `findPendingPaymentsForPoll` выбирает строго
 *     `status='pending'`, а захороненный платёж уже `failed` — то есть больше
 *     не опрашивается НИКОГДА (аудит 2026-08-10, HIGH).
 */

// Имя модуля НЕ меняем при выносе кода: по `module="cron.poll-payment"`
// фильтруют задокументированные LogQL-запросы разбора инцидентов
// (docs/runbooks/monitoring.md, infra/hermes/SKILL.md). Переименование сделало
// бы строки об ошибках опроса невидимыми ровно во время инцидента с платежами.
const log = childLogger('cron.poll-payment');

/**
 * `applyTerminal: false` — не трогать терминальные статусы (`expired`,
 * `cancelled`, отмена у Freekassa). Нужно вызывающему `expire-payments`: он сам
 * хоронит заказ И шлёт клиенту «срок оплаты истёк», а обработчики
 * `processInvoiceTerminal`/`processFreekassaTerminal` перевели бы заказ в
 * терминальный статус молча, из-под нас — клиент не получил бы ни одного
 * сообщения (находка ревью). У `poll-payment` терминальная ветка своя и
 * единственная, там дефолт `true`.
 */
export type PollPaymentOptions = { applyTerminal?: boolean };

/**
 * Добор одного платежа L&P. Возвращает true, если оплата была восстановлена
 * (webhook потерялся).
 */
async function pollLoveAndPayPayment(
  payment: PaymentRow,
  applyTerminal: boolean,
): Promise<boolean> {
  const invoice = await getLoveAndPayClient().getInvoice(payment.providerRef);
  const data = {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    amount: invoice.amount,
    currency: invoice.currency,
    status: invoice.status,
  };

  if (invoice.status === 'PAID') {
    await processInvoicePaid({
      data,
      rawPayload: invoice as unknown as Record<string, unknown>,
      recoveredViaPolling: true,
    });
    Sentry.captureMessage('L&P payment recovered via polling — webhook потерян', {
      level: 'warning',
      tags: { source: 'cron.poll-payment' },
      extra: { paymentId: payment.id, invoiceId: invoice.id },
    });
    return true;
  }

  const reason = loveAndPayTerminalReason(invoice.status);
  if (reason && applyTerminal) await processInvoiceTerminal({ data, reason });
  return false;
}

/**
 * Добор одного платежа Freekassa.
 *
 * Отличие от L&P: уведомление провайдер шлёт ТОЛЬКО об успешной оплате, о
 * неуспехе не сообщает вовсе — поэтому опрос закрывает не только потерянные
 * уведомления, но и единственный способ узнать про отменённый счёт.
 *
 * Ищем по НАШЕМУ `paymentId` (он в `provider_invoice_number`): свой
 * идентификатор мы породили и в нём уверены. Если его нет — платёж создан до
 * появления этой колонки или запись битая; падать не на чем, просто пропускаем.
 */
async function pollFreekassaPayment(
  payment: PaymentRow,
  applyTerminal: boolean,
): Promise<boolean> {
  const paymentId = payment.providerInvoiceNumber;
  if (!paymentId) {
    log.warn({
      event: 'cron.poll_payment.freekassa_no_payment_id',
      paymentId: payment.id,
    });
    return false;
  }

  const order = await getFreekassaClient().findOrderByPaymentId(paymentId);
  if (!order) {
    // Заказа у провайдера нет: наш счёт создан, но до их системы не дошёл, либо
    // они его уже удалили. Не терминальное состояние — cron expire-payments
    // похоронит по сроку.
    log.info({ event: 'cron.poll_payment.freekassa_order_absent', paymentId: payment.id });
    return false;
  }

  // Бонус опроса: ответ содержит `fk_order_id`, и здесь видно, совпадает ли он
  // с тем, что мы сохранили при создании (открытый вопрос контракта — равен ли
  // `intid` возвращённому `orderId`).
  if (order.fk_order_id !== payment.providerRef) {
    log.warn({
      event: 'cron.poll_payment.freekassa_ref_mismatch',
      paymentId: payment.id,
      storedProviderRef: payment.providerRef,
      fkOrderId: order.fk_order_id,
    });
  }

  if (order.status === FREEKASSA_ORDER_STATUS.PAID) {
    await processFreekassaPaid({
      intid: order.fk_order_id,
      merchantOrderId: order.merchant_order_id,
      amountRaw: order.amount,
      // `order` уже без PAN: поле `account` не объявлено в схеме и отброшено Zod.
      rawPayload: { order } as unknown as Record<string, unknown>,
      recoveredViaPolling: true,
    });
    Sentry.captureMessage('Freekassa payment recovered via polling — уведомление потеряно', {
      level: 'warning',
      tags: { source: 'cron.poll-payment' },
      extra: { paymentId: payment.id, fkOrderId: order.fk_order_id },
    });
    return true;
  }

  const reason = freekassaTerminalReason(order.status);
  if (reason && applyTerminal) {
    await processFreekassaTerminal({
      intid: order.fk_order_id,
      merchantOrderId: order.merchant_order_id,
      reason,
      providerStatus: order.status,
    });
  }
  return false;
}

/**
 * `recovered` — оплата найдена и проведена (заказ уже `paid`).
 * `skipped` — шлюз ответил, оплаты нет (либо провайдер добора не имеет).
 * `error` — шлюз недоступен, статус платежа НЕИЗВЕСТЕН.
 *
 * Разница между `skipped` и `error` принципиальна для `expire-payments`:
 * хоронить счёт можно только по подтверждённому «не оплачен».
 */
export type PollOutcome = 'recovered' | 'skipped' | 'error';

/**
 * Опрос одного платежа. НЕ бросает: ошибка изолируется здесь, иначе она убила
 * бы воркер пула вместе с остальными платежами его очереди.
 *
 * Цикл провайдер-агностичен (этап 4 ТЗ Freekassa): раньше здесь стоял
 * `if (payment.provider !== 'loveandpay') continue`, и платежи второго шлюза
 * молча оставались без страховки — потерянное уведомление никто не дожимал.
 */
export async function pollPaymentOnce(
  payment: PaymentRow,
  options: PollPaymentOptions = {},
): Promise<PollOutcome> {
  const applyTerminal = options.applyTerminal ?? true;
  try {
    if (payment.provider === 'loveandpay') {
      // Гейт конфигурации симметричен Freekassa (находка ревью): без ключей
      // `getLoveAndPayClient()` бросает, а для `expire-payments` любой бросок —
      // это «статус неизвестен», то есть заказ не хоронится вообще никогда.
      // Отсутствие ключей — не неизвестность, а «опрашивать нечем» (dev-стенд,
      // снятый резервный шлюз).
      if (!isLoveAndPayConfigured()) return 'skipped';
      return (await pollLoveAndPayPayment(payment, applyTerminal)) ? 'recovered' : 'skipped';
    }
    if (payment.provider === 'freekassa') {
      // Ключей нет (dev-стенд) — опрашивать нечем; это не ошибка.
      if (!isFreekassaConfigured()) return 'skipped';
      return (await pollFreekassaPayment(payment, applyTerminal)) ? 'recovered' : 'skipped';
    }
    // Прочие провайдеры (manual и исторические) добора не имеют.
    return 'skipped';
  } catch (err) {
    log.error({
      event: 'cron.poll_payment.error',
      paymentId: payment.id,
      provider: payment.provider,
      err,
    });
    Sentry.captureException(err, {
      tags: { source: 'cron.poll-payment', provider: payment.provider },
      extra: { paymentId: payment.id, providerRef: payment.providerRef },
    });
    return 'error';
  }
}
