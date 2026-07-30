import 'server-only';

import { randomBytes } from 'node:crypto';

import { getDb, getUserTelegramId, type OrderRow } from '@oplati/db';
import {
  FREEKASSA_METHOD_CARD_RUB,
  FREEKASSA_METHOD_SBP,
  type PaymentGateway,
} from '@oplati/types';

import * as Sentry from '@sentry/nextjs';

import { notifyOps } from '../alerts/notify-ops.ts';
import { serverEnv } from '../env.server.ts';
import { getFreekassaClient, isFreekassaConfigured } from '../freekassa/index.ts';
import { getLoveAndPayClient, isLoveAndPayConfigured, LoveAndPayApiError } from '../loveandpay/index.ts';
import { childLogger } from '../logger.ts';
import { isPaymentGatewayUnavailable } from './availability.ts';

/**
 * Слой «создать счёт у текущего шлюза» — единственное место, зависящее от
 * переключателя `PAYMENT_PRIMARY_PROVIDER` (ТЗ, этап 3).
 *
 * Что переключатель НЕ меняет (и не должен):
 *  - вебхуки обоих провайдеров работают всегда — иначе в момент переключения
 *    оплаты по уже выставленным счетам прежнего шлюза не были бы приняты
 *    («деньги списаны, заказ не оплачен»);
 *  - `payments.provider` пишется по фактическому шлюзу при создании строки, а
 *    не выводится из флага задним числом — иначе после переключения история
 *    платежей начала бы врать.
 */

const log = childLogger('payments-gateway');

/** Срок жизни счёта L&P (решение владельца 2026-07-18). */
const LOVEANDPAY_INVOICE_TTL_HOURS = 1;

/**
 * Нормализованный результат создания счёта — общая форма для обоих шлюзов,
 * чтобы `payments/create` не ветвился второй раз при записи в БД.
 */
export type GatewayInvoice = {
  provider: PaymentGateway;
  /** Ключ идемпотентности `UNIQUE(provider, provider_ref)`. */
  providerRef: string;
  /** Отображаемый/наш номер счёта; у Freekassa — наш `MERCHANT_ORDER_ID`. */
  providerInvoiceNumber: string | null;
  paymentUrl: string;
  qrPayload: string | null;
  expiresAt: Date;
  /**
   * Что кладём в `payments.raw_payload`. Общий конверт `{ invoice: {...} }` для
   * обоих провайдеров — по нему `payments/create` отдаёт ссылку повторному
   * confirm'у, не зная, кто выставил счёт.
   */
  rawPayload: Record<string, unknown>;
};

/** Кто принимает деньги прямо сейчас. */
export function primaryPaymentGateway(): PaymentGateway {
  return serverEnv.PAYMENT_PRIMARY_PROVIDER;
}

/**
 * Минимальная принимаемая сумма шлюза в рублях (0 = гейта нет).
 * L&P — 500 ₽ (терминал KANYON); Freekassa минимум не публиковала, поэтому
 * дефолт 0: выдумывать чужой контракт нельзя.
 */
export function minAmountRubFor(gateway: PaymentGateway): number {
  return gateway === 'freekassa'
    ? serverEnv.FREEKASSA_MIN_AMOUNT_RUB
    : serverEnv.LOVEANDPAY_MIN_AMOUNT_RUB;
}

/**
 * Максимальная принимаемая сумма шлюза в рублях (0 = потолка нет).
 * У Freekassa лимит операции 150 000 ₽ по обоим API-методам (СБП и карты РФ),
 * у L&P потолок не объявлен — выдумывать его нельзя.
 */
export function maxAmountRubFor(gateway: PaymentGateway): number {
  return gateway === 'freekassa' ? serverEnv.FREEKASSA_MAX_AMOUNT_RUB : 0;
}

/**
 * Комиссия, которую шлюз добавит ПЛАТЕЛЬЩИКУ поверх суммы нашего счёта
 * (0 = не добавит). У L&P комиссию эквайринга несём мы из своей наценки, у
 * Freekassa она переложена на покупателя настройкой кабинета.
 *
 * Нужна только для ТЕКСТОВ: мы эту надбавку не считаем и не получаем, но обязаны
 * предупредить о ней до нажатия «Оплатить» — иначе на странице провайдера
 * клиента ждёт другая сумма. Привязка к шлюзу намеренная: при
 * `PAYMENT_PRIMARY_PROVIDER=loveandpay` тексты о комиссии не показываются, а при
 * переключении включаются сами, без правки UI.
 */
export function buyerFeePercentFor(gateway: PaymentGateway): number {
  return gateway === 'freekassa' ? serverEnv.FREEKASSA_BUYER_FEE_PERCENT : 0;
}

/** Комиссия текущего шлюза — то, что уходит в UI и тексты бота. */
export function currentBuyerFeePercent(): number {
  return buyerFeePercentFor(primaryPaymentGateway());
}

export type CreateInvoiceInput = {
  gateway: PaymentGateway;
  order: OrderRow;
  /** Сумма заказа в копейках (уже провалидирована вызывающим кодом). */
  amountKopecks: number;
  paymentMethod?: 'sbp' | 'card' | undefined;
};

/**
 * Создать счёт у указанного шлюза; при его недоступности — у резервного.
 *
 * Фоллбэк срабатывает ТОЛЬКО когда:
 *  1. включён `PAYMENT_AUTO_FALLBACK`;
 *  2. ошибка — транспортная (таймаут / сеть / 5xx), а не отказ шлюза: 4xx
 *     означает «шлюз жив и отверг наш запрос», и повтор у другого провайдера
 *     скорее всего упрётся в ту же причину (например, сумма ниже минимума);
 *  3. у резервного шлюза заданы ключи.
 *
 * `payments.provider` пишется по ФАКТУ выставления счёта (`invoice.provider`),
 * поэтому после фоллбэка история платежей остаётся правдивой, а вебхук нужного
 * провайдера примет деньги — он работает независимо от переключателя.
 */
export async function createGatewayInvoice(input: CreateInvoiceInput): Promise<GatewayInvoice> {
  try {
    return await createAtGateway(input.gateway, input);
  } catch (err) {
    const fallback = fallbackGatewayFor(input.gateway);
    if (!fallback || !isPaymentGatewayUnavailable(err)) throw err;

    // Минимум у шлюзов разный (L&P — 500 ₽, Freekassa — не объявлен). Порог
    // проверяется в payments/create ДЛЯ ОСНОВНОГО шлюза, поэтому перед
    // фоллбэком сверяем ещё раз: иначе заказ, проходящий по порогу основного,
    // упёрся бы в отказ резервного — и клиент получил бы невнятную ошибку
    // вместо честного «технический сбой».
    const fallbackMinRub = minAmountRubFor(fallback);
    if (fallbackMinRub > 0 && input.amountKopecks < fallbackMinRub * 100) {
      log.warn({
        event: 'payments.gateway.fallback_below_min',
        fallback,
        amountKopecks: input.amountKopecks,
        fallbackMinRub,
      });
      throw err;
    }

    // Симметрично потолку: у Freekassa лимит операции 150 000 ₽, у L&P потолка
    // нет. Заказ, который основной шлюз принял бы, резервный отверг бы своим
    // лимитом — честнее отдать «технический сбой», чем непрозрачный отказ
    // провайдера уже после того, как клиент нажал «Оплатить».
    const fallbackMaxRub = maxAmountRubFor(fallback);
    if (fallbackMaxRub > 0 && input.amountKopecks > fallbackMaxRub * 100) {
      log.warn({
        event: 'payments.gateway.fallback_above_max',
        fallback,
        amountKopecks: input.amountKopecks,
        fallbackMaxRub,
      });
      throw err;
    }

    log.error({
      event: 'payments.gateway.primary_unavailable',
      primary: input.gateway,
      fallback,
      orderId: input.order.id,
      err,
    });
    Sentry.captureMessage('Основной платёжный шлюз недоступен — счёт выставляется резервным', {
      level: 'warning',
      tags: { source: 'payments.gateway', alert: 'gateway_fallback' },
      extra: { primary: input.gateway, fallback, orderId: input.order.id },
    });

    // Резервный тоже может лечь — тогда наверх уходит ЕГО ошибка, и клиент
    // получит честное «технический сбой» (оба классификатора это покроют).
    const invoice = await createAtGateway(fallback, input);
    await notifyFallbackUsed(input.gateway, fallback);
    return invoice;
  }
}

function createAtGateway(
  gateway: PaymentGateway,
  input: CreateInvoiceInput,
): Promise<GatewayInvoice> {
  return gateway === 'freekassa' ? createFreekassaInvoice(input) : createLoveAndPayInvoice(input);
}

/** Резервный шлюз: другой из двух, если автофоллбэк включён и ключи заданы. */
function fallbackGatewayFor(primary: PaymentGateway): PaymentGateway | null {
  if (!serverEnv.PAYMENT_AUTO_FALLBACK) return null;
  const other: PaymentGateway = primary === 'freekassa' ? 'loveandpay' : 'freekassa';
  const configured = other === 'freekassa' ? isFreekassaConfigured() : isLoveAndPayConfigured();
  if (!configured) {
    log.warn({ event: 'payments.gateway.fallback_not_configured', primary, fallback: other });
    return null;
  }
  return other;
}

// Дедуп DM владельцу: пока основной шлюз лежит, фоллбэк срабатывает на КАЖДОМ
// заказе — личку заспамили бы. Best-effort на warm-инстансе, как в proxy-health.
const FALLBACK_DM_DEDUP_MS = 60 * 60 * 1000;
let lastFallbackDmAt = 0;

/** Только для unit-тестов — сбрасывает окно дедупа DM. */
export function resetFallbackAlertDedupForTests(): void {
  lastFallbackDmAt = 0;
}

async function notifyFallbackUsed(primary: PaymentGateway, fallback: PaymentGateway): Promise<void> {
  const now = Date.now();
  if (now - lastFallbackDmAt < FALLBACK_DM_DEDUP_MS) return;
  lastFallbackDmAt = now;
  try {
    await notifyOps(
      `Основной шлюз (${primary}) не отвечает — счета выставляются через ${fallback}. Деньги принимаются, но причину надо разобрать: автофоллбэк ловит только транспорт, а не «шлюз отвечает, платежи не проходят».`,
    );
  } catch (err) {
    // Сбой доставки DM не должен уронить создание счёта: Sentry-алёрт уже ушёл.
    log.error({ event: 'payments.gateway.fallback_notify_failed', err });
  }
}

// ─── Love & Pay ───────────────────────────────────────────────────────────

async function createLoveAndPayInvoice(input: CreateInvoiceInput): Promise<GatewayInvoice> {
  const { order, amountKopecks, paymentMethod } = input;

  const invoiceResp = await getLoveAndPayClient().createInvoice({
    amount: amountKopecks / 100,
    currency: 'RUB',
    description: `Оплата заказа ${order.shortId}`,
    customer: {},
    expiresInHours: LOVEANDPAY_INVOICE_TTL_HOURS,
    successUrl: paymentSuccessUrl(order.shortId),
    kycRequired: false,
    ...(paymentMethod !== undefined ? { paymentMethod } : {}),
  });

  const invoice = invoiceResp.invoice;
  // paymentLink в схеме optional (в ответе на проверку статуса его нет), но в
  // ответе на СОЗДАНИЕ он обязателен — инвойс без ссылки на оплату непригоден.
  if (!invoice.paymentLink) {
    throw new LoveAndPayApiError({
      code: 'missing_payment_link',
      httpStatus: 502,
      message: 'L&P создал инвойс без paymentLink',
    });
  }

  // Единый нормализованный срок: L&P не вернул expiresAt → считаем сами от TTL.
  // Один и тот же момент уходит в payment, orders.expires_at и ответ клиенту.
  const expiresAt = invoice.expiresAt
    ? new Date(invoice.expiresAt)
    : new Date(Date.now() + LOVEANDPAY_INVOICE_TTL_HOURS * 60 * 60 * 1000);

  return {
    provider: 'loveandpay',
    providerRef: invoice.id,
    providerInvoiceNumber: invoice.invoiceNumber,
    paymentUrl: invoice.paymentLink,
    qrPayload: invoice.qrPayload ?? null,
    expiresAt,
    rawPayload: { invoice } as Record<string, unknown>,
  };
}

// ─── Freekassa ────────────────────────────────────────────────────────────

async function createFreekassaInvoice(input: CreateInvoiceInput): Promise<GatewayInvoice> {
  const { order, amountKopecks, paymentMethod } = input;

  // Наш идентификатор попытки оплаты: вернётся в уведомлении как
  // MERCHANT_ORDER_ID и участвует в его MD5-подписи. Уникален на попытку —
  // повторное выставление счёта по тому же заказу (после провала предыдущего)
  // не должно упереться в «такой заказ уже есть» на стороне провайдера,
  // а поиск платежа по MERCHANT_ORDER_ID остаётся однозначным.
  const paymentId = `${order.shortId}-${randomBytes(3).toString('hex')}`;

  const response = await getFreekassaClient().createOrder({
    paymentId,
    amountKopecks,
    email: await payerEmailForOrder(order),
    ip: serverEnv.FREEKASSA_FALLBACK_IP,
    methodId: freekassaMethodId(paymentMethod),
    currency: 'RUB',
  });

  // Провайдер срок жизни заказа не отдаёт — это НАШ срок ожидания оплаты
  // (`FREEKASSA_INVOICE_TTL_HOURS`), по нему выравнивается `orders.expires_at`.
  const expiresAt = new Date(
    Date.now() + serverEnv.FREEKASSA_INVOICE_TTL_HOURS * 60 * 60 * 1000,
  );

  return {
    provider: 'freekassa',
    // `intid` из уведомления сверяется именно с этим значением; запасной поиск
    // по `providerInvoiceNumber` описан в `lib/freekassa/handlers.ts`.
    providerRef: response.orderId,
    providerInvoiceNumber: paymentId,
    paymentUrl: response.location,
    // СБП-строки для QR провайдер не отдаёт: клиент платит по ссылке.
    qrPayload: null,
    expiresAt,
    rawPayload: {
      // Общий конверт: `payments/create` читает ссылку повторному confirm'у
      // одной схемой для обоих шлюзов.
      invoice: {
        id: response.orderId,
        invoiceNumber: paymentId,
        paymentLink: response.location,
        qrPayload: null,
        expiresAt: expiresAt.toISOString(),
      },
      provider: 'freekassa',
      orderHash: response.orderHash,
    },
  };
}

/** `i` — способ оплаты: 44 СБП, 36 карты РФ; без выбора клиента — дефолт из env. */
function freekassaMethodId(paymentMethod: 'sbp' | 'card' | undefined): number {
  if (paymentMethod === 'sbp') return FREEKASSA_METHOD_SBP;
  if (paymentMethod === 'card') return FREEKASSA_METHOD_CARD_RUB;
  return serverEnv.FREEKASSA_METHOD_ID;
}

/**
 * Email плательщика для Freekassa (поле обязательное).
 *
 * У клиента почты мы не спрашиваем, зато `telegram_id` есть всегда: оплата без
 * привязки Telegram запрещена гейтом `TelegramLinkRequiredError`. Отсюда
 * санкционированный суррогат `<telegram_id>@telegram.org` (ТЗ §4.2).
 *
 * Отсутствие `telegram_id` — аномалия, а не рабочий сценарий, поэтому она
 * алертится, но НЕ роняет оплату: деньги важнее красоты адреса, а «оформи
 * заказ заново» на этом месте выглядело бы как поломка платежей.
 */
async function payerEmailForOrder(order: OrderRow): Promise<string> {
  const telegramId = await getUserTelegramId(getDb(), order.userId);
  if (telegramId) return `${telegramId}@telegram.org`;

  log.warn({
    event: 'payments.gateway.freekassa_email_fallback',
    orderId: order.id,
    shortId: order.shortId,
  });
  return `${order.shortId.toLowerCase()}@telegram.org`;
}

// ─── Общее ────────────────────────────────────────────────────────────────

/**
 * Страница успеха. У L&P уходит в `successUrl` запроса; у Freekassa адреса
 * возврата задаются в кабинете магазина (в `/orders/create` их нет) — там
 * прописан этот же путь.
 */
function paymentSuccessUrl(shortId: string): string {
  const base = serverEnv.APP_URL.replace(/\/$/, '');
  return `${base}/payment-success?order=${encodeURIComponent(shortId)}`;
}
