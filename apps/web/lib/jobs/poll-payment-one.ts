import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  appendOrderEvent,
  getDb,
  getUserTelegramId,
  getOrderById,
  PAYMENT_REVIEW_CLIENT_NOTIFIED_EVENT,
  setPaymentProviderStatus,
  transitionOrder,
  type PaymentRow,
} from '@oplati/db';
import {
  freekassaTerminalReason,
  FREEKASSA_ORDER_STATUS,
  OrderTransitionError,
} from '@oplati/types';

import { childLogger } from '../logger.ts';
import { notifyOps } from '../alerts/notify-ops.ts';
import { getBot } from '../telegram/bot.ts';
import { getFreekassaClient, isFreekassaConfigured } from '../freekassa/index.ts';
import { processFreekassaPaid, processFreekassaTerminal } from '../freekassa/handlers.ts';
import { getLoveAndPayClient, isLoveAndPayConfigured } from '../loveandpay/index.ts';
import {
  loveAndPayTerminalReason,
  processInvoicePaid,
  processInvoiceTerminal,
} from '../loveandpay/handlers.ts';
import { notifyStaff } from '../alerts/notify-staff.ts';
import { SECTION_TITLES } from '../panel/labels.ts';

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

  // Снимок статуса провайдера в payments (антифрод-трек, тикет 03): раньше он
  // жил только в логе и DM — заказ было не с чем сверить. Пишем ДО обработки;
  // best-effort: телеметрия не должна мешать добору денег ниже. Дедуп
  // автосообщения о холде (пачка 3) читает ПРЕЖНЕЕ значение из строки
  // `payment`, загруженной до этого UPDATE, — порядок безопасен.
  try {
    await setPaymentProviderStatus(getDb(), {
      paymentId: payment.id,
      providerStatus: order.status,
    });
  } catch (err) {
    log.error({ event: 'cron.poll_payment.status_snapshot_failed', paymentId: payment.id, err });
    Sentry.captureException(err, {
      tags: { source: 'cron.poll-payment', step: 'status_snapshot' },
      extra: { paymentId: payment.id },
    });
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

  // Антифрод-холд (статус 7, эмпирический — подтверждён поддержкой 2026-08-14):
  // деньги списаны, банк держит перевод на проверке. НЕ терминальный и не
  // «оплачен»: исход решает провайдер. Заказ уходит «на проверку» (перестаёт
  // тикать к протуханию), клиент получает автосообщение РОВНО один раз (дедуп
  // по прежнему `last_provider_status` из строки `payment`, загруженной ДО
  // снапшота выше), владельцу — DM с прежним дедупом (тикет 09).
  if (order.status === FREEKASSA_ORDER_STATUS.ANTIFRAUD_HOLD) {
    await handleAntifraudHold(payment, order.fk_order_id);
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

/** Текст клиенту при обнаружении холда (спека §5.3 + строка из §6.1). */
const HOLD_CLIENT_TEXT =
  'Оплату видим! Банк поставил перевод на проверку — это бывает при крупных суммах. ' +
  'Деньги не потеряны, ничего делать не нужно: напишем, как только банк подтвердит. ' +
  'Обычно это занимает до пары часов.\n\n' +
  'Если подтверждения долго нет — открой заказ в кабинете (кнопка «Личный кабинет» в /start-меню) или напиши /support.';

/**
 * Первое обнаружение холда: заказ → «на проверке банка» + автосообщение
 * клиенту; повторные опросы (прежний статус уже 7) не спамят. Best-effort
 * на каждом шаге: сбой сообщения не откатывает переход и наоборот — деньги
 * важнее, а poll вернётся через 5 минут.
 */
async function handleAntifraudHold(payment: PaymentRow, providerOrderId: string): Promise<void> {
  await alertAntifraudHold(payment, providerOrderId);

  const db = getDb();

  // Дедуп «ровно один раз на платёж»: слать только при СМЕНЕ статуса на 7.
  // `payment.lastProviderStatus` — прежний снимок (строка выбрана до записи
  // нового значения выше по функции).
  //
  // ⚠️ Но выйти по одному лишь снимку нельзя. Прежняя версия так и делала, и
  // это оставляло заказ ХОРОНИТЬСЯ: если переход ниже сорвался транзиентно
  // (deadlock, обрыв соединения), снимок «7» уже записан — следующий проход
  // выходил здесь, заказ навсегда оставался `pending_payment`, а через час
  // `expire-payments` уводил его в `expired` вместе с платежом в `failed`.
  // После этого `findPendingPaymentsForPoll` его не опрашивает НИКОГДА, а
  // деньги клиента продолжают висеть у провайдера на проверке. Поэтому повтор
  // гасится не снимком, а фактом: заказ уже доехал до «на проверке».
  if (payment.lastProviderStatus === FREEKASSA_ORDER_STATUS.ANTIFRAUD_HOLD) {
    const current = await getOrderById(db, payment.orderId);
    if (current?.status !== 'pending_payment') return;
    log.warn({
      event: 'cron.poll_payment.hold_transition_retry',
      paymentId: payment.id,
      orderId: payment.orderId,
      status: current.status,
    });
  }

  try {
    await transitionOrder(db, {
      orderId: payment.orderId,
      toStatus: 'payment_review',
      actorType: 'payment_provider',
      eventType: 'payment_review_entered',
      payload: {
        paymentId: payment.id,
        provider: 'freekassa',
        reason: 'antifraud_hold',
        providerStatus: FREEKASSA_ORDER_STATUS.ANTIFRAUD_HOLD,
        providerOrderId,
      },
    });
  } catch (err) {
    // Заказ уже «на проверке» (кнопка клиента, гонка) или ушёл дальше —
    // легитимно; транзиентный сбой БД — залогировать, poll повторит.
    if (!(err instanceof OrderTransitionError)) {
      log.error({ event: 'cron.poll_payment.hold_transition_failed', paymentId: payment.id, err });
      Sentry.captureException(err, {
        tags: { source: 'cron.poll-payment', step: 'hold_transition' },
        extra: { paymentId: payment.id, orderId: payment.orderId },
      });
      return;
    }
  }

  let notified = false;
  try {
    const order = await getOrderById(db, payment.orderId);
    // Guard по фактическому статусу: при гонке с вебхуком заказ мог уже стать
    // paid — «банк проверяет перевод» после подтверждения оплаты дезориентирует.
    if (order?.status !== 'payment_review') return;
    const telegramId = await getUserTelegramId(db, order.userId);
    if (telegramId) {
      await getBot().api.sendMessage(telegramId, HOLD_CLIENT_TEXT);
      notified = true;
      log.info({ event: 'cron.poll_payment.hold_client_notified', orderId: payment.orderId });
    }
  } catch (err) {
    log.warn({ event: 'cron.poll_payment.hold_notify_failed', orderId: payment.orderId, err });
  }

  if (!notified) return;

  // Факт доставки — в журнал заказа, и ТОЛЬКО после успешной отправки. Панель
  // холдов показывает «клиенту ушло» по этой записи, а не выводит из статусов:
  // отправка best-effort, и её отказ («бот заблокирован пользователем» — 403)
  // иначе выглядел бы как предупреждённый клиент, который на деле молчит.
  //
  // ⚠️ Своим try, а не хвостом предыдущего: сбой ЗАПИСИ уже после успешной
  // ОТПРАВКИ — другое событие. Общий catch писал бы `hold_notify_failed` про
  // доставленное сообщение (при разборе инцидента это читается как «клиент не
  // предупреждён»), а сама отметка не появится уже никогда: следующий проход
  // выйдет по дедупу. Значит, в панели навсегда останется «нет отметки», и это
  // единственный шанс узнать, почему.
  try {
    await appendOrderEvent(db, {
      orderId: payment.orderId,
      eventType: PAYMENT_REVIEW_CLIENT_NOTIFIED_EVENT,
      actorType: 'system',
      payload: { paymentId: payment.id, reason: 'antifraud_hold' },
    });
  } catch (err) {
    log.error({
      event: 'cron.poll_payment.hold_notify_fact_lost',
      orderId: payment.orderId,
      err,
    });
    Sentry.captureException(err, {
      tags: { source: 'cron.poll-payment', step: 'hold_notify_fact' },
      extra: { orderId: payment.orderId, paymentId: payment.id },
    });
  }
}

/**
 * DM владельцу об антифрод-холде. Механизм дедупа общий с неизвестными
 * статусами, но КЛЮЧ — со своим префиксом: «холд» и «неизвестный код» —
 * семантически разные сигналы с разными действиями владельца, и переход
 * платежа из одного в другой в пределах часа не должен глушить второй DM
 * (находка ревью части 2).
 */
async function alertAntifraudHold(payment: PaymentRow, providerOrderId: string): Promise<void> {
  log.warn({
    event: 'cron.poll_payment.antifraud_hold',
    paymentId: payment.id,
    providerOrderId,
  });
  Sentry.captureMessage('Freekassa: антифрод-холд — банк держит перевод на проверке', {
    level: 'warning',
    tags: { source: 'cron.poll-payment', alert: 'freekassa_antifraud_hold' },
    extra: { paymentId: payment.id, providerOrderId },
  });

  const now = Date.now();
  const dedupKey = `hold:${payment.id}`;
  const last = unknownStatusAlertedAt.get(dedupKey) ?? 0;
  if (now - last < UNKNOWN_STATUS_DM_DEDUP_MS) return;
  pruneUnknownStatusDedup(now);
  unknownStatusAlertedAt.set(dedupKey, now);

  // Менеджеру — СРАЗУ (тикет 11): раньше про холд узнавали через семь дней и
  // только владелец, через сторож `payment-review-watch`. Дедуп у обоих каналов
  // свой, но ключ один и тот же платёж.
  await notifyStaff(
    `Платёж на проверке банка: операция ${providerOrderId} на ${(payment.amountRub / 100).toFixed(2)} RUB. ` +
      `Деньги списаны, карта не выпущена — исход решает провайдер. ` +
      `Заказ виден в панели, раздел «${SECTION_TITLES.holds}»: /admin/holds`,
    // ⚠️ Без фолбэка владельцу: он идёт следующей строкой и текстом подробнее.
    // С фолбэком на пустом `staff` (а он пуст до заведения персонала) один холд
    // давал бы владельцу два DM подряд.
    { dedupKey: `hold:${payment.id}`, capability: 'holds', fallbackToOps: false },
  );

  await notifyOps(
    `Антифрод-холд Freekassa (статус 7): банк поставил перевод на проверку. ` +
      `Операция ${providerOrderId}, сумма ${(payment.amountRub / 100).toFixed(2)} ₽. ` +
      `Деньги у клиента списаны, карта НЕ выпущена — исход решает провайдер. ` +
      `Обычно разрешается за часы; если висит дольше — запрос в поддержку Freekassa.`,
    { stream: 'payments' },
  );
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
  const dedupKey = `unknown:${payment.id}`;
  const last = unknownStatusAlertedAt.get(dedupKey) ?? 0;
  if (now - last < UNKNOWN_STATUS_DM_DEDUP_MS) return;
  pruneUnknownStatusDedup(now);
  unknownStatusAlertedAt.set(dedupKey, now);

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
    { stream: 'payments' },
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
