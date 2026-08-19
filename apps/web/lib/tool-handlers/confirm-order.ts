import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import type { ConfirmOrderResult } from '@oplati/agent';
import { getDb, getOrderById, getUserTelegramId } from '@oplati/db';

import { selfCallBaseUrl } from '../deployment-url.ts';
import { EMAIL_REQUIRED } from '../contacts/email.ts';
import { PHONE_REQUIRED } from '../contacts/phone.ts';
import { CAPACITY_RETRY_WINDOW, FULFILLMENT_CAPACITY } from '../payments/capacity.ts';
import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';

/**
 * Tool `confirm_order`. Self-call в `/api/payments/create` с `X-Internal-Token`.
 * Возвращает paymentUrl, qrPayload, expiresAt — это то, что AI озвучивает
 * пользователю.
 *
 * Ownership-check (P2-14): если передан `userId` (вызов от AI через
 * createToolHandlers — мы знаем userId из контекста разговора) — проверяем,
 * что заказ принадлежит этому пользователю. Если нет — отказываем, чтобы
 * исключить случай галлюцинации/инъекции с чужим orderId.
 *
 * При вызове из callback-handler'а (нажатие inline-кнопки) `userId` не
 * передаётся — там доверие установлено самим Telegram'ом: кнопка прикреплена
 * к сообщению пользователя, владельца заказа.
 */

const log = childLogger('tool.confirm_order');

/**
 * Маркер «нужно привязать Telegram» — по нему /api/orders/confirm и веб-UI
 * отличают этот кейс от прочих ошибок (и parseToolCards рисует кнопку привязки).
 */
export const TELEGRAM_LINK_REQUIRED = 'telegram_link_required';

export class TelegramLinkRequiredError extends Error {
  constructor() {
    super(
      `${TELEGRAM_LINK_REQUIRED}: у пользователя не привязан Telegram. Подтверждение оплаты, чек и доступы доставляются только сообщением в Telegram, поэтому счёт не создан. Объясни это пользователю одной фразой и попроси нажать кнопку «Связать Telegram» под сообщением.`,
    );
    this.name = 'TelegramLinkRequiredError';
  }
}

/** Маркер «нужна почта» — антифрод-трек (Р2); литерал живёт в lib/contacts. */
export { EMAIL_REQUIRED };

export class EmailRequiredError extends Error {
  constructor() {
    super(
      `${EMAIL_REQUIRED}: в профиле пользователя нет почты, счёт не создан. Попроси пользователя указать почту для связи по заказу (в плашке контактов на экране заказа) и подтвердить оплату ещё раз.`,
    );
    this.name = 'EmailRequiredError';
  }
}

/** Маркер «нужен телефон» — антифрод-трек (тикет 05); литерал в lib/contacts. */
export { PHONE_REQUIRED };

export class PhoneRequiredError extends Error {
  /** Порог в целых рублях из тела 422 — UI показывает его динамически. */
  readonly requiredFromRub: number | null;
  constructor(requiredFromRub: number | null) {
    super(
      `${PHONE_REQUIRED}: для заказов от ${requiredFromRub ?? 'порога'} ₽ банк требует телефон плательщика, счёт не создан. Попроси пользователя указать телефон в контактах заказа (плашка на экране заказа) и подтвердить оплату ещё раз.`,
    );
    this.name = 'PhoneRequiredError';
    this.requiredFromRub = requiredFromRub;
  }
}

/**
 * `/api/payments/create` ответил 503 `provider_unavailable` — лежит транспорт
 * до L&P (squid-прокси / сеть / 5xx провайдера). Это НЕ ошибка запроса: заказ
 * жив, счёт можно выставить позже. Текст читает и AI (tool-loop отдаёт ошибку
 * модели) — формулировка объясняет, что сказать пользователю.
 */
export class PaymentProviderUnavailableError extends Error {
  constructor() {
    super(
      'payment_provider_unavailable: приём оплаты временно недоступен — технический сбой на стороне платёжной системы. Счёт не создан, заказ сохранён. Скажи пользователю попробовать снова через несколько минут.',
    );
    this.name = 'PaymentProviderUnavailableError';
  }
}

/**
 * `/api/payments/create` ответил 409 `order_expired` — фиксация цены протухла
 * (H-2), заказ захоронен сервером. Повторять бессмысленно — нужен новый заказ
 * по свежему курсу.
 */
export class OrderExpiredError extends Error {
  constructor() {
    super(
      'order_expired: срок фиксации цены истёк, заказ закрыт. Скажи пользователю оформить заказ заново — цена пересчитается по свежему курсу.',
    );
    this.name = 'OrderExpiredError';
  }
}

/**
 * `/api/payments/create` ответил 422 `above_max_amount` — сумма выше лимита
 * операции у шлюза (у Freekassa 150 000 ₽, гейт `FREEKASSA_MAX_AMOUNT_RUB`).
 * Повторять бессмысленно: столько этот шлюз не примет ни сейчас, ни через час.
 * Без отдельного типа ошибка падала в generic `Error`, и клиент получал
 * «технический сбой у провайдера» — неправда, которая ещё и обещала оператора.
 */
export class OrderAboveMaxAmountError extends Error {
  readonly maxAmountRub: number | null;
  constructor(maxAmountRub: number | null) {
    super(
      `above_max_amount: сумма заказа выше лимита платёжной системы${
        maxAmountRub ? ` (${maxAmountRub} ₽)` : ''
      }. Счёт не создан. Скажи пользователю оформить заказ на меньшую сумму или написать в поддержку — крупный заказ проведёт оператор.`,
    );
    this.name = 'OrderAboveMaxAmountError';
    this.maxAmountRub = maxAmountRub;
  }
}

/**
 * `/api/payments/create` ответил 422 `fulfillment_capacity` — карточного фонда
 * не хватает на этот заказ, счёт НЕ выставлен (трек vcc-preflight, тикет 02).
 *
 * Отличается от `provider_unavailable` тем, что сломано не у платёжного шлюза,
 * а у нас: он жив и счёт бы принял. Повтор через 10-15 минут осмыслен — фонд
 * пополняется, — поэтому заказ и остаётся живым с зафиксированной ценой.
 */
export class PaymentCapacityError extends Error {
  /** Сколько минут ещё держится цена заказа; null — сказать нечего. */
  readonly priceLockMinutesLeft: number | null;
  constructor(priceLockMinutesLeft: number | null) {
    super(
      `${FULFILLMENT_CAPACITY}: выпустить карту по этому заказу сейчас нечем, счёт не создан. ` +
        `Это временно и на нашей стороне. Скажи пользователю попробовать через ${CAPACITY_RETRY_WINDOW} ` +
        'или написать в поддержку — там помогут вручную. Про баланс и провайдеров не упоминай.',
    );
    this.name = 'PaymentCapacityError';
    this.priceLockMinutesLeft = priceLockMinutesLeft;
  }
}

/**
 * Текст отказа для КЛИЕНТСКИХ каналов (веб, Mini App, бот) — один на все три,
 * чтобы формулировки про деньги не разъезжались. Сообщение самой ошибки выше
 * адресовано AI-агенту и звучит иначе.
 */
export function aboveMaxAmountText(maxAmountRub: number | null): string {
  const limit = maxAmountRub
    ? `${maxAmountRub.toLocaleString('ru-RU')} ₽`
    : 'лимит платёжной системы';
  return `Сумма заказа выше лимита платёжной системы (${limit}). Оформи заказ на меньшую сумму или напиши в поддержку — крупный заказ проведёт оператор.`;
}

/** Тело ошибки /api/payments/create (инвариант «Zod на границах»). */
const errorBodySchema = z.object({
  error: z.string(),
  maxAmountRub: z.number().optional(),
  requiredFromRub: z.number().optional(),
  // Целые неотрицательные минуты: дробь отрендерилась бы клиенту как
  // «12.5 минут», а отрицательная — как обещание уже истёкшей цены.
  priceLockMinutesLeft: z.number().int().nonnegative().nullable().optional(),
});

type ErrorBody = z.infer<typeof errorBodySchema>;

/**
 * Разбор тела ошибки — ОДНА функция на все поля.
 *
 * Раньше их было четыре, по одной на поле, и каждая глушила `JSON.parse`
 * пустым `catch` — то есть трижды нарушала «never swallow errors» ради одного
 * и того же разбора. Теперь ошибка разбора логируется один раз и явно: тело
 * пишет наш же роут, и не-JSON здесь означает, что ответил кто-то другой
 * (прокси, балансировщик) — это стоит увидеть в логах.
 */
function parseErrorBody(respText: string): ErrorBody | null {
  let raw: unknown;
  try {
    raw = JSON.parse(respText);
  } catch (err) {
    // Ожидаемый фоллбек (не-JSON тело → generic-классификация); само тело уже
    // залогировано вызывающим кодом в `tool.confirm_order.failed`.
    log.warn({ event: 'tool.confirm_order.error_body_not_json', err });
    return null;
  }
  const parsed = errorBodySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function confirmOrder(input: {
  orderId: string;
  paymentMethod?: 'sbp' | 'card';
  userId?: string;
}): Promise<ConfirmOrderResult> {
  if (input.userId) {
    const order = await getOrderById(getDb(), input.orderId);
    if (!order || order.userId !== input.userId) {
      log.warn({
        event: 'tool.confirm_order.ownership_mismatch',
        orderId: input.orderId,
        userId: input.userId,
      });
      Sentry.captureMessage('confirm_order: ownership mismatch', {
        level: 'warning',
        tags: { source: 'tool.confirm_order' },
        extra: { orderId: input.orderId, userId: input.userId },
      });
      throw new Error('confirm_order: заказ не найден или принадлежит другому пользователю');
    }

    // Гейт привязки (только веб-канал: из Telegram userId либо не передаётся,
    // либо у пользователя по определению есть telegram_id). Результат заказа —
    // уведомление об оплате и, в фазе 2, реквизиты карты — уходит ТОЛЬКО
    // сообщением в Telegram, поэтому без привязки счёт не выставляем.
    const telegramId = await getUserTelegramId(getDb(), input.userId);
    if (telegramId === null) {
      log.info({ event: 'tool.confirm_order.telegram_link_required', orderId: input.orderId });
      throw new TelegramLinkRequiredError();
    }
  }

  const internalToken = serverEnv.INTERNAL_API_TOKEN;
  if (!internalToken) {
    throw new Error('confirm_order: INTERNAL_API_TOKEN не задан');
  }

  // Self-call должен идти в ТОТ ЖЕ deployment; приоритеты и почему они такие —
  // в `selfCallBaseUrl()` (lib/deployment-url.ts, единый источник правды о
  // «своём базовом URL»).
  const url = `${selfCallBaseUrl()}/api/payments/create`;

  log.info({ event: 'tool.confirm_order.start', orderId: input.orderId });

  const controller = new AbortController();
  // 45с < maxDuration=60 у payments/create и с запасом внутри maxDuration=90
  // вызывающих роутов (/api/chat, /api/bot) — self-call не должен переживать
  // собственную функцию (M-6 аудита).
  const timeoutId = setTimeout(() => controller.abort(), 45_000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': internalToken,
      },
      body: JSON.stringify({
        orderId: input.orderId,
        ...(input.paymentMethod !== undefined ? { paymentMethod: input.paymentMethod } : {}),
      }),
      signal: controller.signal,
    });

    const respText = await resp.text();
    if (!resp.ok) {
      log.error({
        event: 'tool.confirm_order.failed',
        orderId: input.orderId,
        httpStatus: resp.status,
        body: respText.slice(0, 500),
      });
      const errorBody = parseErrorBody(respText);
      const errorCode = errorBody?.error ?? null;
      if (resp.status === 503 && errorCode === 'provider_unavailable') {
        throw new PaymentProviderUnavailableError();
      }
      if (resp.status === 409 && errorCode === 'order_expired') {
        throw new OrderExpiredError();
      }
      if (resp.status === 422 && errorCode === 'above_max_amount') {
        throw new OrderAboveMaxAmountError(errorBody?.maxAmountRub ?? null);
      }
      if (resp.status === 422 && errorCode === EMAIL_REQUIRED) {
        throw new EmailRequiredError();
      }
      if (resp.status === 422 && errorCode === PHONE_REQUIRED) {
        throw new PhoneRequiredError(errorBody?.requiredFromRub ?? null);
      }
      if (resp.status === 422 && errorCode === FULFILLMENT_CAPACITY) {
        throw new PaymentCapacityError(errorBody?.priceLockMinutesLeft ?? null);
      }
      throw new Error(`confirm_order: /api/payments/create вернул ${resp.status}: ${respText.slice(0, 200)}`);
    }

    let parsed: {
      ok?: boolean;
      paymentUrl?: string;
      qrPayload?: string | null;
      expiresAt?: string;
    };
    try {
      parsed = JSON.parse(respText);
    } catch (err) {
      throw new Error(`confirm_order: невалидный JSON в ответе: ${(err as Error).message}`);
    }

    if (!parsed.ok || !parsed.paymentUrl || !parsed.expiresAt) {
      throw new Error(`confirm_order: неполный ответ /api/payments/create: ${respText.slice(0, 200)}`);
    }

    log.info({
      event: 'tool.confirm_order.ok',
      orderId: input.orderId,
    });

    return {
      paymentUrl: parsed.paymentUrl,
      qrPayload: parsed.qrPayload ?? null,
      expiresAt: parsed.expiresAt,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
