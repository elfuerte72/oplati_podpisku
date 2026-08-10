import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  findPendingPaymentsForPoll,
  findStuckInFulfillmentOrders,
  findStuckPaidOrders,
  getDb,
} from '@oplati/db';

import { childLogger } from '../logger.ts';
import { isPaySpaceConfigured } from '../pay-space/index.ts';
import { issueCard } from './issue-card.ts';
import { pollPaymentOnce } from './poll-payment-one.ts';
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
 * Сколько платежей опрашиваем одновременно.
 *
 * Ограничение осознанное, а не «побольше»: каждый опрос — сетевой вызов к шлюзу
 * плюс запись в БД, а пул подключений `postgres` держит 10 соединений. Четыре
 * параллельных потока дают четырёхкратное ускорение худшего случая и оставляют
 * запас и провайдеру (у обоих шлюзов есть свои лимиты), и остальным запросам
 * приложения, которые ходят в ту же БД.
 */
const POLL_CONCURRENCY = 4;

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
    ...(await runWithConcurrency(ordered, 1, pollPaymentOnce)),
    ...(await runWithConcurrency(parallel, POLL_CONCURRENCY, pollPaymentOnce)),
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
