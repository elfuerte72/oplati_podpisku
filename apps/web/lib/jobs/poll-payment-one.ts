import 'server-only';

import * as Sentry from '@sentry/nextjs';

import type { PaymentRow } from '@oplati/db';
import { freekassaTerminalReason, FREEKASSA_ORDER_STATUS } from '@oplati/types';

import { childLogger } from '../logger.ts';
import { notifyOps } from '../alerts/notify-ops.ts';
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
    return false;
  }

  // Статус, которого нет в контракте провайдера, — деньги в подвешенном
  // состоянии (инцидент 14.08.2026).
  //
  // Клиент оплатил 11 680 ₽ по СБП: банк списал, чек есть, а Freekassa вернула
  // `status: 7` — кода нет ни в их документации (2.3: 0/1/6/8/9), ни среди
  // фильтров их же кабинета. Мы правильно НЕ выдали карту (неизвестный статус
  // не терминален и не «оплачен»), но и не сказали никому — о проблеме узнали
  // от клиента через полтора часа.
  //
  // Алертим именно на неизвестный код, а не по таймеру «висит дольше N минут»:
  // больше половины счетов клиенты просто не оплачивают (статус NEW), и алерт
  // на каждый такой превратил бы денежный сигнал в фон. Успешная оплата
  // подтверждается за 30-40 секунд, поэтому аномалия видна на первом же прогоне
  // крона — через ≤5 минут после платежа.
  if (!isKnownFreekassaStatus(order.status)) {
    await alertUnknownProviderStatus(payment, order.status, order.fk_order_id);
  }
  return false;
}

/** Коды из раздела 2.3 документации Freekassa; всё прочее — контрактный дрейф. */
function isKnownFreekassaStatus(status: number): boolean {
  return (Object.values(FREEKASSA_ORDER_STATUS) as number[]).includes(status);
}

/** Те же коды для текста алёрта — чтобы список не жил в строке отдельной копией. */
function knownFreekassaStatusList(): string {
  return (Object.values(FREEKASSA_ORDER_STATUS) as number[]).sort((a, b) => a - b).join('/');
}

// Дедуп DM по платежу: крон бежит каждые 5 минут, а зависший платёж живёт до
// вмешательства человека — без дедупа владелец получал бы сообщение 12 раз в
// час. Тот же приём, что у proxy-health и payment-conversion, но ключ — платёж:
// один застрявший счёт не должен заглушать сигнал о втором.
const UNKNOWN_STATUS_DM_DEDUP_MS = 60 * 60 * 1000;
const unknownStatusAlertedAt = new Map<string, number>();

/**
 * Записи дедупа старше окна не нужны — без чистки Map растёт всё время жизни
 * процесса (находка ревью). Чистим на записи: событие редкое, и отдельный
 * таймер ради него держать незачем.
 */
function pruneUnknownStatusDedup(now: number): void {
  for (const [id, at] of unknownStatusAlertedAt) {
    if (now - at >= UNKNOWN_STATUS_DM_DEDUP_MS) unknownStatusAlertedAt.delete(id);
  }
}

/** Только для unit-тестов — сбрасывает окно дедупа DM. */
export function resetUnknownStatusAlertDedupForTests(): void {
  unknownStatusAlertedAt.clear();
}

async function alertUnknownProviderStatus(
  payment: PaymentRow,
  providerStatus: number,
  providerOrderId: string,
): Promise<void> {
  log.error({
    event: 'cron.poll_payment.unknown_provider_status',
    paymentId: payment.id,
    provider: payment.provider,
    providerStatus,
    providerOrderId,
  });
  Sentry.captureMessage('Freekassa: статус вне контракта — платёж в подвешенном состоянии', {
    level: 'error',
    tags: { source: 'cron.poll-payment', provider: payment.provider },
    extra: { paymentId: payment.id, providerStatus, providerOrderId },
  });

  const now = Date.now();
  const last = unknownStatusAlertedAt.get(payment.id) ?? 0;
  if (now - last < UNKNOWN_STATUS_DM_DEDUP_MS) return;
  pruneUnknownStatusDedup(now);
  unknownStatusAlertedAt.set(payment.id, now);

  // Прямой DM владельцу: Sentry-правила сюда не настроены, а на другом конце —
  // клиент со списанными деньгами и без подписки.
  await notifyOps(
    `Платёж завис у провайдера: Freekassa вернула статус ${providerStatus}, ` +
      // Список берём из контракта, а не из строки: захардкоженная копия
      // разъедется с `FREEKASSA_ORDER_STATUS` при первом же добавлении кода —
      // ровно то дублирование, которое эта ветка убирает в других местах.
      `которого нет в её документации (известны ${knownFreekassaStatusList()}). Операция ` +
      `${providerOrderId}, сумма ${(payment.amountRub / 100).toFixed(2)} ₽. ` +
      `Карта НЕ выпущена. Если клиент говорит, что оплатил, — деньги списаны, ` +
      `но провайдер платёж не подтвердил: нужен запрос в поддержку Freekassa.`,
  );
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
