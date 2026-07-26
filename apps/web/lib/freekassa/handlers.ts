import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  claimPaymentSucceeded,
  claimPaymentTerminal,
  findPaymentByProviderInvoiceNumber,
  findPaymentByProviderRef,
  getDb,
  transitionOrder,
  type PaymentRow,
} from '@oplati/db';
import {
  OrderTransitionError,
  parseRubleAmountToKopecks,
  toStorableNotification,
  type FreekassaNotification,
} from '@oplati/types';

import { notifyOps } from '../alerts/notify-ops.ts';
import { dispatchIssueCard, dispatchPaymentConfirmed } from '../jobs/dispatcher.ts';
import { childLogger } from '../logger.ts';
import { accrueReferralForPayment } from '../referral/accrue.ts';

/**
 * Обработка уведомления Freekassa об оплате.
 *
 * Структурно — копия `lib/loveandpay/handlers.ts` (тот же набор инвариантов),
 * и это осознанно: платёжный путь у двух шлюзов обязан вести себя одинаково,
 * иначе переключатель провайдера меняет не только «кто принимает деньги», но и
 * поведение системы при сбоях.
 *
 * Что здесь держится на инвариантах CLAUDE.md:
 *  - (2) идемпотентность и anti-replay — на атомарном `claimPaymentSucceeded`,
 *    а НЕ на подписи: в MD5-подписи Freekassa нет ни времени, ни nonce, значит
 *    уведомление воспроизводимо в точности как у L&P;
 *  - claim платежа + `transitionOrder(paid)` — в ОДНОЙ транзакции: сбой
 *    перехода откатывает claim, иначе оплаченный заказ застрял бы без recovery;
 *  - (3) `AMOUNT` разбирается точно в копейки (`parseRubleAmountToKopecks`),
 *    без `parseFloat` — иначе сверка недоплаты начнёт врать на копейку.
 *
 * Любой кидающий путь = баг: границу вебхука ловит try/catch → 200 (инвариант 6).
 */

const log = childLogger('freekassa-handlers');

export type NotificationPaidInput = {
  notification: FreekassaNotification;
  /** true — уведомление добрано cron'ом, а не пришло вебхуком (этап 4 ТЗ). */
  recoveredViaPolling?: boolean;
};

export type FreekassaHandlerResult =
  | { kind: 'processed'; paymentId: string; orderId: string }
  | { kind: 'idempotent_skip'; paymentId: string; reason: string }
  | { kind: 'amount_mismatch'; paymentId: string; expectedKopecks: number; gotKopecks: number }
  | { kind: 'invalid_amount'; providerRef: string; rawAmount: string }
  | { kind: 'not_found'; providerRef: string };

/**
 * Поиск нашего платежа по уведомлению.
 *
 * Основной ключ — `intid` (идентификатор операции у провайдера) в
 * `payments.provider_ref`. ⚠️ Равенство `intid` тому `orderId`, который
 * провайдер вернул при создании заказа, докой НЕ гарантировано и живым вызовом
 * не подтверждено (`FREEKASSA_SHOP_ID` ещё не выдан). Поэтому есть запасной
 * путь — по `MERCHANT_ORDER_ID` (нашему `paymentId`, он уникален на попытку и
 * сохранён в `provider_invoice_number`). Срабатывание запасного пути алертится:
 * это ответ на открытый вопрос контракта, его нужно занести в
 * docs/reference/freekassa-api.md, а не оставлять «просто работающим».
 */
async function findPaymentForNotification(
  n: FreekassaNotification,
): Promise<{ payment: PaymentRow; viaFallback: boolean } | null> {
  const db = getDb();

  const byRef = await findPaymentByProviderRef(db, 'freekassa', n.intid);
  if (byRef) return { payment: byRef, viaFallback: false };

  const byOurId = await findPaymentByProviderInvoiceNumber(db, 'freekassa', n.MERCHANT_ORDER_ID);
  if (!byOurId) return null;

  log.warn({
    event: 'freekassa.handlers.matched_by_merchant_order_id',
    intid: n.intid,
    merchantOrderId: n.MERCHANT_ORDER_ID,
    paymentId: byOurId.id,
    providerRef: byOurId.providerRef,
  });
  Sentry.captureMessage('Freekassa: intid не совпал с сохранённым orderId — платёж найден по MERCHANT_ORDER_ID', {
    level: 'warning',
    tags: { source: 'freekassa.handlers', alert: 'intid_mismatch' },
    extra: {
      intid: n.intid,
      merchantOrderId: n.MERCHANT_ORDER_ID,
      storedProviderRef: byOurId.providerRef,
    },
  });
  return { payment: byOurId, viaFallback: true };
}

export async function processFreekassaPaid(
  input: NotificationPaidInput,
): Promise<FreekassaHandlerResult> {
  const { notification: n, recoveredViaPolling = false } = input;
  const db = getDb();

  const found = await findPaymentForNotification(n);
  if (!found) {
    log.warn({
      event: 'freekassa.handlers.payment_not_found',
      intid: n.intid,
      merchantOrderId: n.MERCHANT_ORDER_ID,
    });
    Sentry.captureMessage('Freekassa: уведомление об оплате без нашего payment', {
      level: 'warning',
      tags: { source: 'freekassa.webhook' },
      extra: { intid: n.intid, merchantOrderId: n.MERCHANT_ORDER_ID },
    });
    return { kind: 'not_found', providerRef: n.intid };
  }
  const { payment } = found;

  // Точный разбор рублёвой строки в копейки. Нечитаемая сумма — НЕ повод
  // фулфилить «на глазок»: без сверки мы выпустили бы карту на полную сумму,
  // не зная, сколько денег реально пришло. Останавливаемся и алертим.
  const gotKopecks = parseRubleAmountToKopecks(n.AMOUNT);
  if (gotKopecks === null) {
    log.error({
      event: 'freekassa.handlers.unparsable_amount',
      paymentId: payment.id,
      orderId: payment.orderId,
      rawAmount: n.AMOUNT,
    });
    Sentry.captureMessage('Freekassa: неразбираемая сумма в уведомлении — fulfillment остановлен', {
      level: 'error',
      tags: { source: 'freekassa.handlers', alert: 'unparsable_amount' },
      extra: { paymentId: payment.id, orderId: payment.orderId, rawAmount: n.AMOUNT },
    });
    return { kind: 'invalid_amount', providerRef: n.intid, rawAmount: n.AMOUNT };
  }

  const rawPayload = toStorableNotification(n);

  // Недоплата терминальна (тот же путь, что M-3 у L&P): платёж и заказ → failed
  // в одной транзакции + РОВНО один DM владельцу (дедуп атомарным
  // `claimPaymentTerminal`; повторы уведомления молчат). Допуск 1 копейка —
  // на округление у провайдера.
  if (gotKopecks < payment.amountRub - 1) {
    log.error({
      event: 'freekassa.handlers.amount_mismatch',
      paymentId: payment.id,
      orderId: payment.orderId,
      expectedKopecks: payment.amountRub,
      gotKopecks,
    });
    Sentry.captureMessage('Freekassa: оплачено меньше выставленного — fulfillment остановлен', {
      level: 'error',
      tags: { source: 'freekassa.handlers', alert: 'amount_mismatch' },
      extra: {
        paymentId: payment.id,
        orderId: payment.orderId,
        expectedKopecks: payment.amountRub,
        gotKopecks,
        intid: n.intid,
      },
    });

    const mismatchClaimed = await db.transaction(async (tx) => {
      const row = await claimPaymentTerminal(tx, payment.id, log);
      if (!row) return null;
      try {
        await transitionOrder(tx, {
          orderId: payment.orderId,
          toStatus: 'failed',
          actorType: 'payment_provider',
          eventType: 'payment_amount_mismatch',
          payload: {
            paymentId: payment.id,
            provider: 'freekassa',
            intid: n.intid,
            merchantOrderId: n.MERCHANT_ORDER_ID,
            expectedKopecks: payment.amountRub,
            gotKopecks,
          },
        });
      } catch (err) {
        // OrderTransitionError — легитимная гонка (заказ уже ушёл иным путём):
        // claim фиксируем, переход пропускаем. Транзиентный сбой — re-throw,
        // он откатит и claim.
        if (!(err instanceof OrderTransitionError)) throw err;
        log.warn({
          event: 'freekassa.handlers.mismatch_transition_skip',
          orderId: payment.orderId,
          err,
        });
        Sentry.captureException(err, {
          level: 'warning',
          tags: { source: 'freekassa.handlers', step: 'transition_mismatch' },
          extra: { orderId: payment.orderId, intid: n.intid },
        });
      }
      return row;
    });

    if (mismatchClaimed) {
      // Вне транзакции: DM не должен держать соединение и откатываться с ней.
      await notifyOps(
        `Недоплата по заказу (Freekassa): выставлено ${(payment.amountRub / 100).toFixed(2)} ₽, оплачено ${(gotKopecks / 100).toFixed(2)} ₽ (операция ${n.intid}). Заказ переведён в failed, карта НЕ выпущена — нужен ручной возврат клиенту.`,
      );
    }

    return {
      kind: 'amount_mismatch',
      paymentId: payment.id,
      expectedKopecks: payment.amountRub,
      gotKopecks,
    };
  }

  // Claim (`pending → succeeded`) и переход заказа в `paid` — В ОДНОЙ
  // транзакции. Сбой перехода откатывает claim → платёж остаётся pending →
  // добор (этап 4 ТЗ) или повтор уведомления обработает заново.
  type PaidTxOutcome = { claimed: false } | { claimed: true; paidOk: boolean };
  const outcome: PaidTxOutcome = await db.transaction(async (tx) => {
    const claimed = await claimPaymentSucceeded(tx, {
      paymentId: payment.id,
      webhookReceivedAt: new Date(),
      rawPayload,
      recoveredViaPolling,
    });
    if (!claimed) return { claimed: false };

    try {
      await transitionOrder(tx, {
        orderId: payment.orderId,
        toStatus: 'paid',
        actorType: 'payment_provider',
        eventType: 'payment_succeeded',
        payload: {
          paymentId: payment.id,
          provider: 'freekassa',
          intid: n.intid,
          merchantOrderId: n.MERCHANT_ORDER_ID,
          recoveredViaPolling,
        },
      });
    } catch (err) {
      if (!(err instanceof OrderTransitionError)) throw err;
      log.error({
        event: 'freekassa.handlers.paid_transition_failed',
        orderId: payment.orderId,
        err,
      });
      Sentry.captureException(err, {
        level: 'error',
        tags: { source: 'freekassa.handlers', step: 'transition_paid' },
        extra: { orderId: payment.orderId, intid: n.intid },
      });
      return { claimed: true, paidOk: false };
    }
    return { claimed: true, paidOk: true };
  });

  if (!outcome.claimed) {
    // Отличаем безобидный дубль (повтор уведомления) от оплаты ЗАХОРОНЕННОГО
    // счёта: cron expire-payments клеймит pending→failed превентивно, и позднее
    // «оплачено» утонуло бы здесь как idempotent_skip — при том что деньги
    // реально приняты. Статус перечитываем: `payment` прочитан до транзакции.
    const current = await findPaymentByProviderRef(db, 'freekassa', payment.providerRef);
    if (current?.status === 'failed') {
      log.error({
        event: 'freekassa.handlers.paid_after_terminal',
        paymentId: payment.id,
        orderId: payment.orderId,
      });
      Sentry.captureMessage('Freekassa: оплата по захороненному счёту — деньги приняты, нужен ручной возврат', {
        level: 'error',
        tags: { source: 'freekassa.handlers', alert: 'paid_after_terminal' },
        extra: { paymentId: payment.id, orderId: payment.orderId, intid: n.intid },
      });
      await notifyOps(
        `Оплата пришла по уже захороненному счёту (Freekassa, операция ${n.intid}): деньги приняты, заказ НЕ выполняется — нужен ручной возврат клиенту.`,
      );
      return { kind: 'idempotent_skip', paymentId: payment.id, reason: 'paid_after_terminal' };
    }
    log.info({
      event: 'freekassa.handlers.idempotent_skip',
      paymentId: payment.id,
      reason: 'already_processed',
    });
    return { kind: 'idempotent_skip', paymentId: payment.id, reason: 'already_processed' };
  }

  // Побочные эффекты — только когда заказ реально перешёл в paid.
  if (outcome.paidOk) {
    dispatchPaymentConfirmed(payment.orderId);
    dispatchIssueCard(payment.orderId);
    // Реферальные начисления — inline await (дёшево и гарантированно до 200 OK).
    await accrueReferralForPayment({ orderId: payment.orderId, paymentId: payment.id });
  }

  log.info({
    event: 'freekassa.handlers.paid_processed',
    paymentId: payment.id,
    orderId: payment.orderId,
    recoveredViaPolling,
  });

  return { kind: 'processed', paymentId: payment.id, orderId: payment.orderId };
}
