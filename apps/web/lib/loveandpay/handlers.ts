import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  claimPaymentSucceeded,
  claimPaymentTerminal,
  findPaymentByProviderRef,
  getDb,
  transitionOrder,
} from '@oplati/db';
import {
  OrderTransitionError,
  type LoveAndPayInvoiceStatus,
  type LoveAndPayWebhookData,
} from '@oplati/types';

import { childLogger } from '../logger.ts';
import { dispatchIssueCard, dispatchPaymentConfirmed } from '../jobs/dispatcher.ts';
import { notifyOps } from '../alerts/notify-ops.ts';
import { accrueReferralForPayment } from '../referral/accrue.ts';

/**
 * Общие хендлеры обработки L&P-событий (как из webhook, так и из cron poll-payment).
 *
 * Помещены отдельно от route'а, чтобы один и тот же код обрабатывал:
 *   - синхронный путь: webhook `POST /api/payments/loveandpay` → processInvoicePaid
 *   - подстраховку: cron `poll-payment` → processInvoicePaid (с recoveredViaPolling=true)
 *
 * Любой кидающий путь = баг. На границе webhook'а / cron'а всё ловится try/catch
 * → 200 OK + Sentry (см. CLAUDE.md → инвариант 6).
 */

const log = childLogger('loveandpay-handlers');

export type InvoicePaidInput = {
  data: LoveAndPayWebhookData;
  rawPayload: Record<string, unknown>;
  recoveredViaPolling?: boolean;
};

export type HandlerResult =
  | { kind: 'processed'; paymentId: string; orderId: string }
  | { kind: 'idempotent_skip'; paymentId: string; reason: string }
  | { kind: 'amount_mismatch'; paymentId: string; expectedKopecks: number; gotKopecks: number }
  | { kind: 'not_found'; providerRef: string };

/**
 * Обработка `invoice.paid`. Идемпотентно: если payment уже `succeeded` или order
 * уже `paid`/`in_fulfillment`/`completed`, ничего не делаем (`transitionOrder`
 * это форсит на уровне `allowedTransitions`, но мы ещё и сами проверяем).
 */
export async function processInvoicePaid(input: InvoicePaidInput): Promise<HandlerResult> {
  const { data, rawPayload, recoveredViaPolling = false } = input;
  const db = getDb();

  const payment = await findPaymentByProviderRef(db, 'loveandpay', data.id);
  if (!payment) {
    log.warn({
      event: 'loveandpay.handlers.payment_not_found',
      providerRef: data.id,
      invoiceNumber: data.invoiceNumber,
    });
    Sentry.captureMessage('L&P invoice.paid без нашего payment', {
      level: 'warning',
      tags: { source: 'loveandpay.webhook' },
      extra: { providerRef: data.id, invoiceNumber: data.invoiceNumber },
    });
    return { kind: 'not_found', providerRef: data.id };
  }

  // Сверка суммы оплаты с суммой заказа. L&P шлёт `amount` в РУБЛЯХ (не копейках);
  // наш `payment.amountRub` — копейки. В webhook-пути `amount` опционален и может
  // прийти как 0 — тогда сверку пропускаем (нечего сравнивать). При polling-пути
  // (getInvoice) сумма всегда реальная. Если оплачено заметно МЕНЬШЕ выставленного
  // (допуск 1 копейка на округление) — НЕ фулфилим: иначе выпустим карту на полную
  // сумму, получив неполную оплату (прямой убыток). Деньги-вопрос → разбирает оператор.
  const gotKopecks = Math.round(data.amount * 100);
  if (gotKopecks > 0 && gotKopecks < payment.amountRub - 1) {
    log.error({
      event: 'loveandpay.handlers.amount_mismatch',
      paymentId: payment.id,
      orderId: payment.orderId,
      expectedKopecks: payment.amountRub,
      gotKopecks,
    });
    Sentry.captureMessage('L&P invoice.paid: оплачено меньше выставленного — fulfillment остановлен', {
      level: 'error',
      tags: { source: 'loveandpay.handlers', alert: 'amount_mismatch' },
      extra: {
        paymentId: payment.id,
        orderId: payment.orderId,
        expectedKopecks: payment.amountRub,
        gotKopecks,
        invoiceId: data.id,
        invoiceNumber: data.invoiceNumber,
      },
    });

    // Терминальный путь недоплаты (M-3 аудита 2026-07-18). Раньше платёж
    // оставался pending навсегда: poll ре-алертил каждые 5 мин 25 часов, затем
    // забывал, а cron позже хоронил заказ как «срок истёк» при частично
    // принятых деньгах. Теперь: платёж → failed, заказ → failed (не expired —
    // деньги частично пришли, нужен ручной возврат), DM владельцу один раз
    // (повторы webhook/poll получают claim=null и DM не шлют). Паттерн
    // транзакции — как в processInvoiceTerminal: транзиентный сбой перехода
    // откатывает claim, OrderTransitionError (заказ уже ушёл иным путём) —
    // фиксируем claim, переход пропускаем.
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
            invoiceId: data.id,
            invoiceNumber: data.invoiceNumber,
            expectedKopecks: payment.amountRub,
            gotKopecks,
          },
        });
      } catch (err) {
        if (!(err instanceof OrderTransitionError)) throw err;
        log.warn({
          event: 'loveandpay.handlers.mismatch_transition_skip',
          orderId: payment.orderId,
          err,
        });
        Sentry.captureException(err, {
          level: 'warning',
          tags: { source: 'loveandpay.handlers', step: 'transition_mismatch' },
          extra: { orderId: payment.orderId, invoiceId: data.id },
        });
      }
      return row;
    });

    if (mismatchClaimed) {
      // Вне транзакции: DM не должен держать соединение/откатываться вместе с ней.
      await notifyOps(
        `Недоплата по заказу: выставлено ${(payment.amountRub / 100).toFixed(2)} ₽, оплачено ${(gotKopecks / 100).toFixed(2)} ₽ (инвойс ${data.invoiceNumber ?? data.id}). Заказ переведён в failed, карта НЕ выпущена — нужен ручной возврат клиенту.`,
      );
    }

    return { kind: 'amount_mismatch', paymentId: payment.id, expectedKopecks: payment.amountRub, gotKopecks };
  }

  // Claim платежа (`pending → succeeded`) и переход заказа в `paid` — В ОДНОЙ
  // транзакции (находка аудита C1). Раньше это были два отдельных запроса, и
  // транзиентный сбой БД между ними давал payment=succeeded при заказе в
  // pending_payment: ретраи webhook'а получали idempotent_skip, poll видел
  // «не pending» — а cron expire-payments хоронил ОПЛАЧЕННЫЙ заказ в expired.
  // Теперь сбой перехода откатывает и claim → payment остаётся pending →
  // poll-payment повторит обработку в ≤5 минут.
  //
  // Claim по-прежнему at-most-once: строку получит ровно ОДИН из конкурентных
  // вызовов (webhook vs poll, ретраи L&P); проигравший останавливается ДО
  // любых побочных эффектов — иначе двойной топ-ап карты (двойная трата).
  //
  // Запрещённый переход (OrderTransitionError — «оплата мёртвого счёта»,
  // cancelled/expired) — легитимная аномалия: claim фиксируем (деньги реально
  // приняты), fulfillment/начисления не запускаем, алертим.
  type PaidTxOutcome = { claimed: false } | { claimed: true; paidOk: boolean };
  const outcome: PaidTxOutcome = await db.transaction(async (tx) => {
    const claimed = await claimPaymentSucceeded(tx, {
      paymentId: payment.id,
      webhookReceivedAt: new Date(),
      rawPayload,
      recoveredViaPolling,
    });
    if (!claimed) return { claimed: false };

    // Переход pending_payment → paid. Если order уже paid (race с другим путём) —
    // transitionOrder вернёт noop (from === to), не бросая.
    try {
      await transitionOrder(tx, {
        orderId: payment.orderId,
        toStatus: 'paid',
        actorType: 'payment_provider',
        eventType: 'payment_succeeded',
        payload: {
          paymentId: payment.id,
          provider: 'loveandpay',
          invoiceId: data.id,
          invoiceNumber: data.invoiceNumber,
          recoveredViaPolling,
        },
      });
    } catch (err) {
      if (!(err instanceof OrderTransitionError)) {
        // Транзиентный сбой (обрыв соединения, timeout) — НЕ аномалия статуса.
        // Re-throw откатывает транзакцию вместе с claim'ом: платёж остаётся
        // pending, poll-payment повторит. Границы webhook/cron это ловят → 200.
        throw err;
      }
      log.error({
        event: 'loveandpay.handlers.paid_transition_failed',
        orderId: payment.orderId,
        err,
      });
      Sentry.captureException(err, {
        level: 'error',
        tags: { source: 'loveandpay.handlers', step: 'transition_paid' },
        extra: { orderId: payment.orderId, invoiceId: data.id, invoiceNumber: data.invoiceNumber },
      });
      return { claimed: true, paidOk: false };
    }
    return { claimed: true, paidOk: true };
  });

  if (!outcome.claimed) {
    // Различаем безобидный дубль (платёж уже succeeded — ретрай webhook / гонка
    // с poll) и оплату ЗАХОРОНЕННОГО платежа: с L-4 cron expire-payments клеймит
    // pending→failed превентивно, и поздний invoice.paid раньше утонул бы здесь
    // как idempotent_skip — а деньги в L&P реально приняты (находка ревью волны
    // 2026-07-19; до L-4 этот кейс алертился через OrderTransitionError).
    // Статус перечитываем: `payment` прочитан до транзакции и мог устареть.
    const current = await findPaymentByProviderRef(db, 'loveandpay', data.id);
    if (current?.status === 'failed') {
      log.error({
        event: 'loveandpay.handlers.paid_after_terminal',
        paymentId: payment.id,
        orderId: payment.orderId,
      });
      Sentry.captureMessage('L&P invoice.paid по захороненному платежу — деньги приняты, нужен ручной возврат', {
        level: 'error',
        tags: { source: 'loveandpay.handlers', alert: 'paid_after_terminal' },
        extra: { paymentId: payment.id, orderId: payment.orderId, invoiceId: data.id },
      });
      // Возможный повторный DM при ретрае webhook'а принят: кейс редкий и
      // денежный, атомарного состояния для дедупа здесь уже нет (платёж failed).
      await notifyOps(
        `Оплата пришла по уже захороненному счёту (инвойс ${data.invoiceNumber ?? data.id}): деньги приняты L&P, заказ НЕ выполняется — нужен ручной возврат клиенту.`,
      );
      return { kind: 'idempotent_skip', paymentId: payment.id, reason: 'paid_after_terminal' };
    }
    log.info({
      event: 'loveandpay.handlers.idempotent_skip',
      paymentId: payment.id,
      reason: 'already_processed',
    });
    return { kind: 'idempotent_skip', paymentId: payment.id, reason: 'already_processed' };
  }

  // Побочные эффекты — только когда заказ реально перешёл в paid (находка
  // аудита I4: раньше «Оплата получена, обрабатываем заказ» уходило и клиенту,
  // оплатившему мёртвый счёт, хотя обработка не начиналась). Аномальный кейс
  // (paidOk=false) уже заалерчен выше — им занимается оператор.
  if (outcome.paidOk) {
    // Уведомляем пользователя в Telegram, что оплата получена — срабатывает всегда
    // при переходе в `paid` (даже если PaySpace не настроен и карта не выпускается).
    dispatchPaymentConfirmed(payment.orderId);

    // После успешной оплаты — запускаем issue-card. Sync-fallback через
    // setImmediate; реальный Trigger.dev задеплоится в отдельном milestone.
    dispatchIssueCard(payment.orderId);

    // Реферальные начисления (из маржи). At-most-once: сюда попадает только
    // победитель claim; внутри — graceful + идемпотентность по UNIQUE. Inline
    // await (а не dispatch): дёшево, и гарантированно отрабатывает до 200 OK
    // (setImmediate Vercel может заморозить).
    await accrueReferralForPayment({ orderId: payment.orderId, paymentId: payment.id });
  }

  log.info({
    event: 'loveandpay.handlers.invoice_paid_processed',
    paymentId: payment.id,
    orderId: payment.orderId,
    recoveredViaPolling,
  });

  return { kind: 'processed', paymentId: payment.id, orderId: payment.orderId };
}

export type InvoiceTerminalInput = {
  data: LoveAndPayWebhookData;
  /** Какой terminal status — `expired` или `cancelled`. */
  reason: 'expired' | 'cancelled';
};

export async function processInvoiceTerminal(input: InvoiceTerminalInput): Promise<HandlerResult> {
  const { data, reason } = input;
  const db = getDb();

  const payment = await findPaymentByProviderRef(db, 'loveandpay', data.id);
  if (!payment) {
    log.warn({
      event: 'loveandpay.handlers.payment_not_found',
      providerRef: data.id,
      invoiceNumber: data.invoiceNumber,
      reason,
    });
    return { kind: 'not_found', providerRef: data.id };
  }

  // Атомарный claim pending→failed. Условие status='pending' внутри UPDATE —
  // источник правды идемпотентности (не устаревшее чтение payment.status выше):
  // если терминальное событие пришло после того, как paid-путь конкурентно
  // перевёл платёж в succeeded и выпустил карту, claim вернёт null, и мы НЕ
  // перезаписываем succeeded→failed (иначе рассинхрон сверки).
  //
  // Claim и переход заказа — В ОДНОЙ транзакции (симметрично processInvoicePaid,
  // находка аудита 2026-07-11 F-05). Раньше claim коммитился отдельно: транзиентный
  // сбой на transitionOrder оставлял payment=failed при заказе в pending_payment,
  // а повтор webhook'а получал idempotent_skip и переход не доигрывался никогда.
  // Теперь транзиентный сбой откатывает и claim → ретрай L&P/poll обработает заново.
  // OrderTransitionError — НЕ транзиентный сбой, а легитимная гонка (заказ уже
  // ушёл иным путём: оплачен, истёк по cron): claim фиксируем, переход пропускаем.
  const claimed = await db.transaction(async (tx) => {
    const row = await claimPaymentTerminal(tx, payment.id, log);
    if (!row) return null;

    try {
      await transitionOrder(tx, {
        orderId: payment.orderId,
        toStatus: reason,
        actorType: 'payment_provider',
        eventType: `payment_${reason}`,
        payload: { paymentId: payment.id, invoiceId: data.id, invoiceNumber: data.invoiceNumber },
      });
    } catch (err) {
      if (!(err instanceof OrderTransitionError)) {
        // Транзиентный сбой — re-throw откатывает транзакцию вместе с claim'ом.
        throw err;
      }
      log.warn({
        event: 'loveandpay.handlers.terminal_transition_skip',
        orderId: payment.orderId,
        reason,
        err,
      });
      Sentry.captureException(err, {
        level: 'warning',
        tags: { source: 'loveandpay.handlers', step: 'transition_terminal' },
        extra: { orderId: payment.orderId, invoiceId: data.id, reason },
      });
    }
    return row;
  });

  if (!claimed) {
    log.info({
      event: 'loveandpay.handlers.idempotent_skip',
      paymentId: payment.id,
      reason: 'not_pending',
    });
    return { kind: 'idempotent_skip', paymentId: payment.id, reason: 'not_pending' };
  }

  log.info({
    event: 'loveandpay.handlers.invoice_terminal_processed',
    paymentId: payment.id,
    orderId: payment.orderId,
    reason,
  });

  return { kind: 'processed', paymentId: payment.id, orderId: payment.orderId };
}

/** Маппер на наш terminal-кейс. */
export function loveAndPayTerminalReason(
  externalStatus: LoveAndPayInvoiceStatus,
): 'expired' | 'cancelled' | null {
  if (externalStatus === 'EXPIRED') return 'expired';
  if (externalStatus === 'CANCELLED') return 'cancelled';
  return null;
}
