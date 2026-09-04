import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  claimPaymentSucceeded,
  claimPaymentTerminal,
  findPaymentByProviderInvoiceNumber,
  findPaymentByProviderRef,
  getDb,
  getOrderById,
  getPayerPhoneForOrder,
  getUserTelegramId,
  transitionOrder,
  type PaymentRow,
} from '@oplati/db';
import {
  FREEKASSA_ORDER_STATUS,
  OrderTransitionError,
  parseRubleAmountToKopecks,
} from '@oplati/types';

import { notifyOps } from '../alerts/notify-ops.ts';
import { phoneTailMatches } from '../contacts/phone-match.ts';
import { getBot } from '../telegram/bot.ts';
import { dispatchIssueCard, dispatchPaymentConfirmed } from '../jobs/dispatcher.ts';
import { childLogger } from '../logger.ts';
import { accrueReferralForPayment } from '../referral/accrue.ts';
import { reverseReferralAccrualsForFailedOrder } from '../referral/reverse.ts';

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

/**
 * Нормализованный вход обработчика — НЕ сырое уведомление.
 *
 * Тот же факт «этот счёт оплачен» приходит двумя путями: вебхуком (form-data с
 * подписью) и добором из cron `poll-payment` (ответ `POST /orders`, где нет ни
 * `SIGN`, ни заголовков). Общая форма избавляет от подделки полей уведомления
 * ради переиспользования кода и держит оба пути на одной логике.
 */
export type FreekassaPaidInput = {
  /** Идентификатор операции/заказа у провайдера (`intid` / `fk_order_id`). */
  intid: string;
  /** Наш `paymentId` (`MERCHANT_ORDER_ID` уведомления). */
  merchantOrderId: string;
  /** Сумма СЫРОЙ строкой — в копейки переводим сами, точно. */
  amountRaw: string;
  /** Что сохранить в `payments.raw_payload` (уже без PAN и подписи). */
  rawPayload: Record<string, unknown>;
  /** true — факт оплаты добран cron'ом, а не пришёл вебхуком. */
  recoveredViaPolling?: boolean;
  /**
   * Маскированный счёт плательщика из уведомления (`****XXXX`, тикет 07) — для
   * сверки хвоста с телефоном профиля. У добора его нет (в `/orders` поле не
   * объявлено) — сверка тогда null.
   */
  payerAccountMasked?: string | undefined;
};

export type FreekassaHandlerResult =
  | { kind: 'processed'; paymentId: string; orderId: string }
  | { kind: 'idempotent_skip'; paymentId: string; reason: string }
  | { kind: 'amount_mismatch'; paymentId: string; expectedKopecks: number; gotKopecks: number }
  | { kind: 'invalid_amount'; providerRef: string; rawAmount: string }
  /** `intid` указал на платёж с другим подписанным номером заказа — не кредитуем. */
  | { kind: 'ref_mismatch'; providerRef: string; merchantOrderId: string }
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
 *
 * ⚠️ **Найденный по `intid` платёж СВЕРЯЕТСЯ с подписанным номером заказа**
 * (аудит 2026-08-10). В MD5-подпись уведомления входят только
 * `MERCHANT_ID:AMOUNT:секрет:MERCHANT_ORDER_ID` — `intid` не подписан вовсе.
 * Без сверки уведомление, чей `intid` совпал с `provider_ref` ДРУГОГО платежа,
 * кредитовало бы чужой заказ. При расхождении побеждает подписанное поле:
 * `intid` подделывается, `MERCHANT_ORDER_ID` — нет.
 *
 * `'conflict'` — по `intid` нашёлся чужой платёж, а по подписанному номеру не
 * нашлось ничего: состояние аномальное, кредитовать нельзя (вызывающий просит
 * провайдера повторить).
 */
async function findPaymentForNotification(ref: {
  intid: string;
  merchantOrderId: string;
}): Promise<PaymentRow | 'conflict' | null> {
  const db = getDb();

  const byRef = await findPaymentByProviderRef(db, 'freekassa', ref.intid);
  if (byRef && byRef.providerInvoiceNumber === ref.merchantOrderId) return byRef;

  // Легаси-строка без сохранённого номера заказа. Для freekassa-платежей это
  // невозможно (колонка появилась миграцией 0004, сам провайдер — 0025), но
  // если такая строка когда-нибудь появится (ручная правка, восстановленный
  // бэкап), сверять нечем — принимаем по `intid` и оставляем след, иначе
  // защита тихо выключилась бы именно на той строке, где нужна.
  if (byRef && byRef.providerInvoiceNumber === null) {
    log.warn({
      event: 'freekassa.handlers.legacy_payment_without_invoice_number',
      intid: ref.intid,
      merchantOrderId: ref.merchantOrderId,
      paymentId: byRef.id,
    });
    return byRef;
  }

  const byOurId = await findPaymentByProviderInvoiceNumber(
    db,
    'freekassa',
    ref.merchantOrderId,
  );

  // РОВНО ОДИН алёрт на аномалию (находка ревью): раньше расхождение по
  // `intid` зажигало и error-алёрт сверки, и старый warning «найден по
  // MERCHANT_ORDER_ID», который задокументирован как сигнал занести вывод о
  // контракте провайдера в docs/reference/freekassa-api.md. Две трактовки
  // одного события — прямой путь к неверному выводу о контракте.
  if (byRef) {
    const resolved = byOurId
      ? 'платёж найден по подписанному номеру'
      : 'по подписанному номеру не найдено ничего';
    log.error({
      event: 'freekassa.handlers.merchant_order_id_mismatch',
      intid: ref.intid,
      merchantOrderId: ref.merchantOrderId,
      matchedByRefPaymentId: byRef.id,
      matchedByRefInvoiceNumber: byRef.providerInvoiceNumber,
      resolvedPaymentId: byOurId?.id ?? null,
    });
    Sentry.captureMessage(
      `Freekassa: intid указал на платёж с ДРУГИМ номером заказа — ${resolved}`,
      {
        level: 'error',
        tags: { source: 'freekassa.handlers', alert: 'merchant_order_id_mismatch' },
        extra: {
          intid: ref.intid,
          merchantOrderId: ref.merchantOrderId,
          matchedByRefPaymentId: byRef.id,
          matchedByRefInvoiceNumber: byRef.providerInvoiceNumber,
          resolvedPaymentId: byOurId?.id ?? null,
        },
      },
    );
    return byOurId ?? 'conflict';
  }

  if (!byOurId) return null;

  log.warn({
    event: 'freekassa.handlers.matched_by_merchant_order_id',
    intid: ref.intid,
    merchantOrderId: ref.merchantOrderId,
    paymentId: byOurId.id,
    providerRef: byOurId.providerRef,
  });
  Sentry.captureMessage('Freekassa: intid не совпал с сохранённым orderId — платёж найден по MERCHANT_ORDER_ID', {
    level: 'warning',
    tags: { source: 'freekassa.handlers', alert: 'intid_mismatch' },
    extra: {
      intid: ref.intid,
      merchantOrderId: ref.merchantOrderId,
      storedProviderRef: byOurId.providerRef,
    },
  });
  return byOurId;
}

export async function processFreekassaPaid(
  input: FreekassaPaidInput,
): Promise<FreekassaHandlerResult> {
  const { intid, merchantOrderId, amountRaw, rawPayload, recoveredViaPolling = false } = input;
  const db = getDb();

  const matched = await findPaymentForNotification({ intid, merchantOrderId });
  if (matched === 'conflict') {
    // Алёрт уже отправлен внутри поиска. Просим повторить: доставка не
    // считается успешной, а деньги, если они реальны, добьёт cron poll-payment.
    return { kind: 'ref_mismatch', providerRef: intid, merchantOrderId };
  }
  const payment = matched;
  if (!payment) {
    log.warn({
      event: 'freekassa.handlers.payment_not_found',
      intid,
      merchantOrderId,
    });
    Sentry.captureMessage('Freekassa: уведомление об оплате без нашего payment', {
      level: 'warning',
      tags: { source: 'freekassa.webhook' },
      extra: { intid, merchantOrderId },
    });
    return { kind: 'not_found', providerRef: intid };
  }

  // Точный разбор рублёвой строки в копейки. Нечитаемая сумма — НЕ повод
  // фулфилить «на глазок»: без сверки мы выпустили бы карту на полную сумму,
  // не зная, сколько денег реально пришло. Останавливаемся и алертим.
  const gotKopecks = parseRubleAmountToKopecks(amountRaw);
  if (gotKopecks === null) {
    log.error({
      event: 'freekassa.handlers.unparsable_amount',
      paymentId: payment.id,
      orderId: payment.orderId,
      rawAmount: amountRaw,
    });
    Sentry.captureMessage('Freekassa: неразбираемая сумма в уведомлении — fulfillment остановлен', {
      level: 'error',
      tags: { source: 'freekassa.handlers', alert: 'unparsable_amount' },
      extra: { paymentId: payment.id, orderId: payment.orderId, rawAmount: amountRaw },
    });
    return { kind: 'invalid_amount', providerRef: intid, rawAmount: amountRaw };
  }

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
        intid: intid,
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
            intid: intid,
            merchantOrderId: merchantOrderId,
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
          extra: { orderId: payment.orderId, intid: intid },
        });
      }
      return row;
    });

    if (mismatchClaimed) {
      // Заказ ушёл в failed — реферальные начисления по нему гасим (R-1),
      // симметрично L&P и фулфилменту.
      await reverseReferralAccrualsForFailedOrder(payment.orderId);

      // Вне транзакции: DM не должен держать соединение и откатываться с ней.
      await notifyOps(
        `Недоплата по заказу (Freekassa): выставлено ${(payment.amountRub / 100).toFixed(2)} ₽, оплачено ${(gotKopecks / 100).toFixed(2)} ₽ (операция ${intid}). Заказ переведён в failed, карта НЕ выпущена — нужен ручной возврат клиенту.`,
        { stream: 'payments', title: 'Недоплата (Freekassa)', action: { text: 'вернуть деньги клиенту вручную', path: '/admin/orders?s=failed' } },
      );
    }

    return {
      kind: 'amount_mismatch',
      paymentId: payment.id,
      expectedKopecks: payment.amountRub,
      gotKopecks,
    };
  }

  // Сверка телефона (тикет 07): хвост маскированного счёта плательщика против
  // номера из профиля. Только пометка в meta события — Р4: несовпадение НИЧЕГО
  // не блокирует (телефон СБП может законно отличаться). Best-effort: сбой
  // чтения профиля не должен мешать приёму денег.
  let phoneMatch: boolean | null = null;
  let phoneSource: string | null = null;
  if (input.payerAccountMasked !== undefined) {
    try {
      const payerPhone = await getPayerPhoneForOrder(db, payment.orderId);
      phoneMatch = phoneTailMatches(input.payerAccountMasked, payerPhone?.phone ?? null);
      phoneSource = payerPhone?.phoneSource ?? null;
    } catch (err) {
      log.error({ event: 'freekassa.handlers.phone_match_failed', paymentId: payment.id, err });
      Sentry.captureException(err, { tags: { source: 'freekassa.handlers', step: 'phone_match' } });
    }
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
          intid: intid,
          merchantOrderId: merchantOrderId,
          recoveredViaPolling,
          // Сверка телефона (тикет 07): пометка для оператора, не фильтр (Р4).
          phone_match: phoneMatch,
          phone_source: phoneSource,
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
        extra: { orderId: payment.orderId, intid: intid },
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
        extra: { paymentId: payment.id, orderId: payment.orderId, intid: intid },
      });
      await notifyOps(
        `Оплата пришла по уже захороненному счёту (Freekassa, операция ${intid}): деньги приняты, заказ НЕ выполняется — нужен ручной возврат клиенту.`,
        { stream: 'critical', title: 'Оплата по захороненному счёту (Freekassa)', action: { text: 'вернуть деньги клиенту вручную', path: '/admin/orders?s=failed' } },
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
  } else {
    // Платёж succeeded, а заказ в paid не перешёл (запрещённый переход из
    // expired/cancelled). Деньги приняты, fulfillment не запустится, и ни один
    // recovery такое не подхватит: `findStuckPaidOrders` ищет `paid`,
    // `findPendingPaymentsForPoll` — `pending`. До аудита 2026-07-28 это
    // уходило только в Sentry — то есть могло остаться незамеченным.
    await notifyOps(
      `Оплата принята (Freekassa, операция ${intid}), но заказ не удалось перевести в оплаченный — карта НЕ выпущена. Нужен ручной разбор: заказ ${payment.orderId}.`,
      { stream: 'critical', title: 'Оплата принята, заказ не переведён (Freekassa)', action: { text: 'разобрать заказ вручную', path: '/admin/pending' } },
    );
  }

  log.info({
    event: 'freekassa.handlers.paid_processed',
    paymentId: payment.id,
    orderId: payment.orderId,
    recoveredViaPolling,
  });

  return { kind: 'processed', paymentId: payment.id, orderId: payment.orderId };
}

export type FreekassaTerminalInput = {
  intid: string;
  merchantOrderId: string;
  /** Куда хороним заказ: `cancelled` (отмена/возврат) или `failed` (ошибка). */
  reason: 'cancelled' | 'failed';
  /** Код статуса провайдера — для события и разбора постфактум. */
  providerStatus: number;
};

/**
 * Терминальный исход счёта (провайдер сказал «отменён / ошибка / возврат»).
 *
 * Приходит ТОЛЬКО из добора (`poll-payment`): уведомление Freekassa шлётся
 * лишь об успешной оплате, о неуспехе нас никто не оповещает — без этого
 * пути мёртвый счёт висел бы `pending`, пока его не похоронит cron по сроку.
 *
 * Симметрично `processInvoiceTerminal` у L&P: атомарный claim `pending→failed`
 * и переход заказа — в ОДНОЙ транзакции. Условие `status='pending'` внутри
 * claim (а не устаревшее чтение выше) — источник правды идемпотентности: если
 * платёж успел стать `succeeded`, claim вернёт null и мы НЕ перезапишем его в
 * `failed`.
 */
export async function processFreekassaTerminal(
  input: FreekassaTerminalInput,
): Promise<FreekassaHandlerResult> {
  const { intid, merchantOrderId, reason, providerStatus } = input;
  const db = getDb();

  const matched = await findPaymentForNotification({ intid, merchantOrderId });
  if (matched === 'conflict') {
    // Хоронить платёж, в принадлежности которого мы не уверены, нельзя тем
    // более: терминальный переход необратим. Алёрт уже отправлен в поиске.
    return { kind: 'ref_mismatch', providerRef: intid, merchantOrderId };
  }
  const payment = matched;
  if (!payment) {
    log.warn({ event: 'freekassa.handlers.terminal_payment_not_found', intid, merchantOrderId });
    return { kind: 'not_found', providerRef: intid };
  }

  // Был ли заказ «на проверке банка» (тикет 09): у такого клиента деньги
  // СПИСАНЫ — молчаливое захоронение оставило бы его без ответа. Читаем до
  // транзакции: после перехода статус уже терминальный.
  let wasUnderReview = false;
  try {
    wasUnderReview = (await getOrderById(db, payment.orderId))?.status === 'payment_review';
  } catch (err) {
    log.error({ event: 'freekassa.handlers.review_lookup_failed', orderId: payment.orderId, err });
    Sentry.captureException(err, { tags: { source: 'freekassa.handlers', step: 'review_lookup' } });
  }

  const claimed = await db.transaction(async (tx) => {
    const row = await claimPaymentTerminal(tx, payment.id, log);
    if (!row) return null;
    try {
      await transitionOrder(tx, {
        orderId: payment.orderId,
        toStatus: reason,
        actorType: 'payment_provider',
        eventType: `payment_${reason}`,
        payload: {
          paymentId: payment.id,
          provider: 'freekassa',
          intid,
          merchantOrderId,
          providerStatus,
        },
      });
    } catch (err) {
      // Транзиентный сбой — re-throw откатывает транзакцию вместе с claim'ом.
      if (!(err instanceof OrderTransitionError)) throw err;
      log.warn({
        event: 'freekassa.handlers.terminal_transition_skip',
        orderId: payment.orderId,
        reason,
        err,
      });
      Sentry.captureException(err, {
        level: 'warning',
        tags: { source: 'freekassa.handlers', step: 'transition_terminal' },
        extra: { orderId: payment.orderId, intid, reason },
      });
    }
    return row;
  });

  if (!claimed) {
    // Возврат по УЖЕ оплаченному платежу (тикет 11): claim не выдан, потому
    // что платёж давно `succeeded` — деньги были приняты и уехали обратно, а
    // заказ, возможно, исполнен. Автоматики нет — только громкая денежная
    // аномалия (лог + Sentry + DM), разбирает человек.
    if (providerStatus === FREEKASSA_ORDER_STATUS.REFUND && payment.status === 'succeeded') {
      log.error({
        event: 'freekassa.handlers.refund_on_succeeded',
        paymentId: payment.id,
        orderId: payment.orderId,
      });
      Sentry.captureMessage('Freekassa: возврат по УЖЕ оплаченному платежу — деньги уехали обратно', {
        level: 'error',
        tags: { source: 'freekassa.handlers', alert: 'refund_on_succeeded' },
        extra: { paymentId: payment.id, orderId: payment.orderId, intid },
      });
      await notifyOps(
        `Денежная аномалия: Freekassa показывает ВОЗВРАТ (статус 6) по платежу, который у нас ` +
          `оплачен (операция ${intid}, сумма ${(payment.amountRub / 100).toFixed(2)} ₽). ` +
          `Деньги вернулись отправителю, а заказ мог быть исполнен — нужна ручная сверка ` +
          `заказа и запрос в поддержку Freekassa.`,
        { stream: 'payments', title: 'Возврат по оплаченному платежу (Freekassa)', action: { text: 'сверить заказ и написать в поддержку Freekassa', path: '/admin/orders' } },
      );
    }
    log.info({
      event: 'freekassa.handlers.idempotent_skip',
      paymentId: payment.id,
      reason: 'not_pending',
    });
    return { kind: 'idempotent_skip', paymentId: payment.id, reason: 'not_pending' };
  }

  // Исход холда «отказ/отмена/возврат» (тикет 09): у клиента списаны деньги —
  // честный текст вместо тишины + DM владельцу. Best-effort: сбой доставки не
  // меняет результат обработки.
  if (wasUnderReview) {
    try {
      const order = await getOrderById(db, payment.orderId);
      const telegramId = order ? await getUserTelegramId(db, order.userId) : null;
      if (telegramId) {
        await getBot().api.sendMessage(
          telegramId,
          'Банк отклонил перевод — деньги вернутся отправителю (обычно в течение пары дней). ' +
            'Заказ можно оформить заново. Если деньги не вернутся — напиши /support, разберёмся.',
        );
      }
    } catch (err) {
      log.warn({ event: 'freekassa.handlers.review_reject_notify_failed', orderId: payment.orderId, err });
    }
    // notifyOps never-throw (гасит ошибки сам) — отдельная обёртка не нужна.
    await notifyOps(
      `Холд разрешился ОТКАЗОМ: банк отклонил перевод по заказу (операция ${intid}, ` +
        `сумма ${(payment.amountRub / 100).toFixed(2)} ₽). Клиенту отправлено сообщение, ` +
        `деньги должны вернуться отправителю — стоит проследить.`,
      { stream: 'payments', title: 'Холд разрешился отказом', action: { text: 'проследить возврат денег клиенту', path: '/admin/holds' } },
    );
  }

  // Возврат (статус 6) по счёту, который у нас НЕ был отмечен оплаченным —
  // денежная аномалия: деньги приняли и вернули, а мы этого не видели.
  // Хороним как cancelled, но требуем ручной сверки.
  if (providerStatus === FREEKASSA_ORDER_STATUS.REFUND) {
    log.error({
      event: 'freekassa.handlers.refund_on_pending',
      paymentId: payment.id,
      orderId: payment.orderId,
    });
    Sentry.captureMessage('Freekassa: возврат по счёту, который у нас не был оплачен — нужна ручная сверка', {
      level: 'error',
      tags: { source: 'freekassa.handlers', alert: 'refund_on_pending' },
      extra: { paymentId: payment.id, orderId: payment.orderId, intid },
    });
  }

  log.info({
    event: 'freekassa.handlers.terminal_processed',
    paymentId: payment.id,
    orderId: payment.orderId,
    reason,
    providerStatus,
  });

  return { kind: 'processed', paymentId: payment.id, orderId: payment.orderId };
}
