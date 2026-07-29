import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  findPendingPaymentsForPoll,
  findStuckInFulfillmentOrders,
  findStuckPaidOrders,
  getDb,
  type PaymentRow,
} from '@oplati/db';
import { freekassaTerminalReason, FREEKASSA_ORDER_STATUS } from '@oplati/types';

import { childLogger } from '../logger.ts';
import { isPaySpaceConfigured } from '../pay-space/index.ts';
import { getFreekassaClient, isFreekassaConfigured } from '../freekassa/index.ts';
import {
  processFreekassaPaid,
  processFreekassaTerminal,
} from '../freekassa/handlers.ts';
import { getLoveAndPayClient } from '../loveandpay/index.ts';
import {
  loveAndPayTerminalReason,
  processInvoicePaid,
  processInvoiceTerminal,
} from '../loveandpay/handlers.ts';
import { issueCard } from './issue-card.ts';
import { alertOnZeroPaymentConversion } from './payment-conversion.ts';
import { alertOnLoveAndPayProxyDown } from './proxy-health.ts';
import { alertOnLowVccBalance } from './vcc-balance.ts';

/**
 * Cron `poll-payment` — подстраховка от потерянных L&P-webhook'ов И от
 * потерянного issue-card (fire-and-forget через setImmediate не переживает
 * cold-shutdown инстанса).
 *
 * Каждые 5 минут (см. apps/web/vercel.json → crons):
 *   1. Проверяем pending платежи (старше 10 мин, не древнее 25 ч): если статус
 *      сменился в L&P — повторяем handler'ы (recoveredViaPolling=true).
 *   2. Recovery fulfillment: заказы, зависшие в `paid` дольше порога, повторно
 *      прогоняем через issue-card (идемпотентно — claim защищает от двойного
 *      топ-апа). Только когда PaySpace настроен: иначе `paid` — это намеренное
 *      состояние для ручного fulfillment, дёргать нечего.
 */

const log = childLogger('cron.poll-payment');

// Заказ в `paid` дольше этого порога считаем «issue-card потерян» (нормальный
// выпуск стартует через setImmediate в пределах секунд после оплаты).
const STUCK_PAID_THRESHOLD_MS = 10 * 60 * 1000;

// Заказ в `in_fulfillment` дольше этого порога — аномалия (нормальный выпуск
// карты завершается за секунды-минуты). Авто-перевыпуск НЕБЕЗОПАСЕН (риск
// двойного fee+суммы, если карта уже выпущена в провайдере) — только алёрт оператору.
const STUCK_IN_FULFILLMENT_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Добор одного платежа L&P. Возвращает true, если оплата была восстановлена
 * (webhook потерялся).
 */
async function pollLoveAndPayPayment(payment: PaymentRow): Promise<boolean> {
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
  if (reason) await processInvoiceTerminal({ data, reason });
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
async function pollFreekassaPayment(payment: PaymentRow): Promise<boolean> {
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
  if (reason) {
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
 * Сколько платежей опрашиваем одновременно.
 *
 * Ограничение осознанное, а не «побольше»: каждый опрос — сетевой вызов к шлюзу
 * плюс запись в БД, а пул подключений `postgres` держит 10 соединений. Четыре
 * параллельных потока дают четырёхкратное ускорение худшего случая и оставляют
 * запас и провайдеру (у обоих шлюзов есть свои лимиты), и остальным запросам
 * приложения, которые ходят в ту же БД.
 */
const POLL_CONCURRENCY = 4;

type PollOutcome = 'recovered' | 'skipped' | 'error';

/**
 * Опрос одного платежа. НЕ бросает: ошибка изолируется здесь, иначе она убила
 * бы воркер пула вместе с остальными платежами его очереди.
 *
 * Цикл провайдер-агностичен (этап 4 ТЗ Freekassa): раньше здесь стоял
 * `if (payment.provider !== 'loveandpay') continue`, и платежи второго шлюза
 * молча оставались без страховки — потерянное уведомление никто не дожимал.
 */
async function pollOne(payment: PaymentRow): Promise<PollOutcome> {
  try {
    if (payment.provider === 'loveandpay') {
      return (await pollLoveAndPayPayment(payment)) ? 'recovered' : 'skipped';
    }
    if (payment.provider === 'freekassa') {
      // Ключей нет (dev-стенд) — опрашивать нечем; это не ошибка.
      if (!isFreekassaConfigured()) return 'skipped';
      return (await pollFreekassaPayment(payment)) ? 'recovered' : 'skipped';
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

/**
 * Пул фиксированного размера: `limit` воркеров разбирают общую очередь, пока
 * она не кончится. Не `Promise.all` по всей выборке — залп из сотни запросов
 * к шлюзу и БД и есть тот отказ, от которого страхует этот крон.
 */
async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  // `Math.max(1, …)` — предохранитель: limit <= 0 дал бы ноль воркеров, и вся
  // выборка молча пропускалась бы при отчёте «обработано N».
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next++;
      // Конец очереди — по ДЛИНЕ, а не по `items[index] === undefined`: иначе
      // элемент-`undefined` в середине выборки тихо обрывал бы воркер, и хвост
      // очереди не обрабатывался (находка ревью).
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Разбивает список надвое по предикату: `[совпавшие, остальные]`. */
function partition<T>(items: readonly T[], pred: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (pred(item) ? yes : no).push(item);
  return [yes, no];
}

export async function pollPayments(): Promise<{
  processed: number;
  recovered: number;
  refulfilled: number;
  errors: number;
}> {
  log.info({ event: 'cron.poll_payment.start' });

  const db = getDb();
  const pending = await findPendingPaymentsForPoll(db);

  log.info({ event: 'cron.poll_payment.found', count: pending.length });

  // Платежи опрашиваются пулом. Последовательный цикл упирался в сумму задержек
  // провайдера: при тормозящем шлюзе (таймаут клиента — 30 с) выборка не влезала
  // в шаг крона, и часть платежей просто не опрашивалась — а это единственная
  // страховка потерянных вебхуков.
  //
  // ⚠️ Freekassa опрашивается СТРОГО ПОСЛЕДОВАТЕЛЬНО (находка ревью). Её API
  // требует `nonce`, который «должен всегда быть больше предыдущего»
  // (docs/reference/freekassa-api.md §6). Последовательность Postgres даёт
  // монотонную ВЫДАЧУ, но не порядок ПРИБЫТИЯ: четыре одновременных запроса
  // уходят с nonce N…N+3 и приходят к провайдеру как попало, а запрос с меньшим
  // номером после большего отвергается. Прежний цикл держал порядок самим фактом
  // `await`, и терять это ради скорости в денежном пути нельзя — тем более что
  // живым вызовом контракт проверен только на одиночных запросах.
  //
  // У Love&Pay nonce нет, там параллелизм безопасен и даёт весь выигрыш.
  const [ordered, parallel] = partition(pending, (p) => p.provider === 'freekassa');
  const outcomes = [
    ...(await runWithConcurrency(ordered, 1, pollOne)),
    ...(await runWithConcurrency(parallel, POLL_CONCURRENCY, pollOne)),
  ];
  const recovered = outcomes.filter((o) => o === 'recovered').length;
  let errors = outcomes.filter((o) => o === 'error').length;

  // Recovery потерянного issue-card: заказы, зависшие в `paid`. Идемпотентно —
  // issueCard claim'ит paid → in_fulfillment атомарно, повторный прогон не
  // пополняет карту дважды. Только при настроенном PaySpace.
  let refulfilled = 0;
  if (isPaySpaceConfigured()) {
    try {
      const stuck = await findStuckPaidOrders(db, { olderThanMs: STUCK_PAID_THRESHOLD_MS });
      if (stuck.length > 0) {
        log.warn({ event: 'cron.poll_payment.stuck_paid_found', count: stuck.length });
        Sentry.captureMessage('Заказы зависли в paid — повторный issue-card', {
          level: 'warning',
          tags: { source: 'cron.poll-payment' },
          extra: { count: stuck.length },
        });
        for (const order of stuck) {
          try {
            // Внутри cron (maxDuration=300) ждём завершения — детерминированнее
            // fire-and-forget. issueCard сам ловит свои ошибки (markOrderFailed).
            await issueCard(order.id);
            refulfilled++;
          } catch (err) {
            errors++;
            log.error({ event: 'cron.poll_payment.refulfill_error', orderId: order.id, err });
            Sentry.captureException(err, {
              tags: { source: 'cron.poll-payment', step: 'refulfill' },
              extra: { orderId: order.id },
            });
          }
        }
      }
    } catch (err) {
      errors++;
      log.error({ event: 'cron.poll_payment.stuck_query_error', err });
      Sentry.captureException(err, { tags: { source: 'cron.poll-payment', step: 'stuck_query' } });
    }

    // Заказы, зависшие в `in_fulfillment` (карта могла быть выпущена в провайдере,
    // но не записана в БД — recovery их не подберёт). Не авто-перевыпускаем —
    // только алёртим, оператор сверяет по кабинету PaySpace.
    try {
      const stuckFulfilling = await findStuckInFulfillmentOrders(db, {
        olderThanMs: STUCK_IN_FULFILLMENT_THRESHOLD_MS,
      });
      if (stuckFulfilling.length > 0) {
        log.error({
          event: 'cron.poll_payment.stuck_in_fulfillment',
          count: stuckFulfilling.length,
          orderIds: stuckFulfilling.map((o) => o.id),
        });
        Sentry.captureMessage('Заказы зависли в in_fulfillment — нужна ручная сверка карт PaySpace', {
          level: 'error',
          tags: { source: 'cron.poll-payment', alert: 'stuck_in_fulfillment' },
          extra: { count: stuckFulfilling.length, orderIds: stuckFulfilling.map((o) => o.id) },
        });
      }
    } catch (err) {
      errors++;
      log.error({ event: 'cron.poll_payment.stuck_fulfilling_query_error', err });
      Sentry.captureException(err, {
        tags: { source: 'cron.poll-payment', step: 'stuck_fulfilling_query' },
      });
    }

    // Мониторинг фонда под выпуск карт — каждые 5 минут, чтобы поймать уход
    // баланса в ноль посреди дня (пополнение VCC — T+1).
    await alertOnLowVccBalance();
  }

  // Мониторинг CONNECT-прокси L&P (H-3: SPOF приёма денег) — вне гейта
  // PaySpace: приём рублей критичен независимо от выпуска карт. Сам ловит
  // свои ошибки, cron не роняет.
  await alertOnLoveAndPayProxyDown();

  // Конверсия «счёт выставлен → оплачен»: единственный сигнал отказа вида
  // «шлюз отвечает 200, а платежи не проходят» — транспортный детектор его не
  // видит. Тоже сам ловит свои ошибки.
  await alertOnZeroPaymentConversion();

  log.info({
    event: 'cron.poll_payment.done',
    processed: pending.length,
    recovered,
    refulfilled,
    errors,
  });

  return { processed: pending.length, recovered, refulfilled, errors };
}
