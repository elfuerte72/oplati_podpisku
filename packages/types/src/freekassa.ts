import { z } from 'zod';

/**
 * Zod-контракт Freekassa (второй шлюз приёма рублей, ТЗ docs/plan-freekassa-integration.md).
 *
 * ⚠️ Источник — ТОЛЬКО документация <https://docs.freekassa.net/> (разделы 1.4,
 * 1.7, 2.2 и «Создать заказ и получить ссылку на оплату»). Живым вызовом
 * контракт НЕ подтверждён: на 2026-07-26 `FREEKASSA_SHOP_ID` ещё не выдан.
 * На этом проекте документация провайдеров врала дважды (L&P — тестовая панель
 * шлёт другой формат событий; PaySpace — суммы то строкой, то числом), поэтому
 * схемы здесь намеренно терпимы к форме значений (число/строка), но строги к
 * НАЛИЧИЮ полей: дрейф ловится на границе клиента через `safeParse` →
 * `FreekassaContractError`, а не растекается по коду.
 *
 * Фактические ответы после первого живого вызова — в docs/reference/freekassa-api.md.
 */

// ─── Константы контракта ──────────────────────────────────────────────────

/** База API. SCI-форму (pay.fk.money) мы не используем — интеграция строго API. */
export const FREEKASSA_API_BASE_URL = 'https://api.fk.life/v1';

/**
 * Способ оплаты (`i`). Терминология провайдера путает: в доке поле названо
 * «валютой платежа», хотя это именно способ оплаты.
 */
export const FREEKASSA_METHOD_SBP = 44;
export const FREEKASSA_METHOD_CARD_RUB = 36;

/**
 * IP-адреса, с которых провайдер шлёт уведомления (раздел 1.4 доки).
 * ⚠️ Молчаливая смена этого списка на их стороне положила бы приём платежей,
 * поэтому по умолчанию список используется только для алёрта; жёсткий отказ
 * включается env'ом (см. `apps/web/app/api/payments/freekassa/route.ts`).
 */
export const FREEKASSA_NOTIFICATION_IPS = [
  '168.119.157.136',
  '168.119.60.227',
  '178.154.197.79',
  '51.250.54.238',
] as const;

// ─── Деньги ───────────────────────────────────────────────────────────────

/**
 * Точный разбор рублёвой суммы провайдера в копейки.
 *
 * `parseFloat` запрещён (инвариант 3 «деньги — integer в минимальных
 * единицах»): `parseFloat('2490.55') * 100 === 249054.99999999997`, а после
 * округления разница в копейку начала бы врать в сверке `amount_mismatch`.
 * Поэтому строка разбирается посимвольно и целочисленно.
 *
 * Принимаем: `2490`, `2490.5`, `2490.50`, `2490,50` (запятая как разделитель),
 * а также хвост из нулей сверх двух знаков (`2490.5000`) — некоторые шлюзы
 * форматируют суммы с 4 знаками.
 * Отвергаем (→ null): пустое, отрицательное, с разделителем тысяч, с ненулевой
 * дробью мельче копейки (`2490.505` — в копейках непредставимо, молча округлять
 * деньги нельзя), экспоненциальную запись.
 */
export function parseRubleAmountToKopecks(raw: string): number | null {
  const trimmed = raw.trim();
  const m = /^(\d{1,12})(?:[.,](\d{1,10}))?$/.exec(trimmed);
  if (!m) return null;

  const wholePart = m[1];
  if (wholePart === undefined) return null;
  const fractionRaw = m[2] ?? '';

  // Сверх двух знаков допускаем только нули — иначе сумма не представима в
  // копейках, и «округлить» её значило бы потерять/придумать деньги.
  const kopecksDigits = fractionRaw.slice(0, 2).padEnd(2, '0');
  const tail = fractionRaw.slice(2);
  if (tail.length > 0 && /[^0]/.test(tail)) return null;

  const whole = Number(wholePart);
  const kopecks = Number(kopecksDigits);
  if (!Number.isSafeInteger(whole)) return null;

  const total = whole * 100 + kopecks;
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * Копейки → рубли для поля `amount` запроса на создание заказа.
 *
 * КРИТИЧНО для подписи: это же число уходит и в JSON-тело, и в подписываемую
 * строку. `JSON.stringify(2490.5)` и `String(2490.5)` дают один и тот же
 * `"2490.5"` (в JS оба используют алгоритм shortest round-trip), поэтому
 * наша подпись совпадёт с пересчитанной провайдером из распарсенного значения.
 * Никакого отдельного форматирования суммы для подписи быть не должно.
 */
export function kopecksToRubleAmount(kopecks: number): number {
  if (!Number.isInteger(kopecks) || kopecks <= 0) {
    throw new Error(`freekassa: сумма в копейках должна быть целой и положительной (${kopecks})`);
  }
  return kopecks / 100;
}

// ─── Создание заказа: POST /orders/create ─────────────────────────────────

/**
 * Параметры запроса БЕЗ `signature` — ровно то, что участвует в подписи
 * (значения сортируются по ключам и склеиваются через `|`, см. `sign.ts`).
 *
 * `paymentId` — НАШ идентификатор заказа; провайдер вернёт его в уведомлении
 * как `MERCHANT_ORDER_ID`, и он же участвует в MD5-подписи уведомления.
 */
export const freekassaCreateOrderParamsSchema = z.object({
  shopId: z.number().int().positive(),
  nonce: z.number().int().positive(),
  paymentId: z.string().min(1).max(100),
  i: z.number().int().positive(),
  email: z.string().email(),
  ip: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().min(3).max(10),
});
export type FreekassaCreateOrderParams = z.infer<typeof freekassaCreateOrderParamsSchema>;

/**
 * Идентификаторы провайдера приходят то числом, то строкой (урок PaySpace:
 * «дока врёт» именно про типы). Нормализуем в строку — в БД `provider_ref`
 * текстовый, и разнотипица ломала бы идемпотентность `UNIQUE(provider, provider_ref)`.
 */
const freekassaId = z
  .union([z.number().int(), z.string().min(1)])
  .transform((v) => String(v));

export const freekassaCreateOrderResponseSchema = z.object({
  type: z.literal('success'),
  orderId: freekassaId,
  orderHash: z.string().min(1),
  /** Ссылка на форму оплаты — её отдаём клиенту. */
  location: z.string().url(),
});
export type FreekassaCreateOrderResponse = z.infer<typeof freekassaCreateOrderResponseSchema>;

/**
 * Ошибка API. Дока показывает только `{"type": "error"}` и коды 400/401 без
 * фиксированного имени текстового поля — принимаем оба встреченных варианта
 * (`message` / `description`) и не падаем, если провайдер пришлёт своё.
 */
export const freekassaErrorResponseSchema = z
  .object({
    type: z.literal('error'),
    message: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();
export type FreekassaErrorResponse = z.infer<typeof freekassaErrorResponseSchema>;

// ─── Список заказов: POST /orders (добор потерянных уведомлений) ──────────

/**
 * Статусы заказа у провайдера (по доке): `0` новый, `1` оплачен, `6` возврат,
 * `8` ошибка, `9` отмена. Приходят числом; принимаем и строку — типы в ответах
 * платёжных API дрейфуют (урок PaySpace).
 */
export const FREEKASSA_ORDER_STATUS = {
  NEW: 0,
  PAID: 1,
  REFUND: 6,
  ERROR: 8,
  CANCELLED: 9,
} as const;

const freekassaNumeric = z
  .union([z.number(), z.string().min(1)])
  .transform((v) => String(v));

/**
 * Заказ в ответе `/orders`.
 *
 * ⚠️ Поле `account` (номер счёта/карты плательщика — в примере доки это ПОЛНЫЙ
 * PAN) НАМЕРЕННО не объявлено: `z.object` по умолчанию отбрасывает
 * неизвестные ключи, поэтому PAN физически не может попасть ни в наш объект,
 * ни в `payments.raw_payload`, ни в логи. Не добавлять сюда без threat-model.
 */
export const freekassaOrderSchema = z.object({
  /** Наш `paymentId`, он же `MERCHANT_ORDER_ID` уведомления. */
  merchant_order_id: z.string().min(1),
  /** Идентификатор заказа на стороне провайдера. */
  fk_order_id: freekassaNumeric,
  /** Сумма; в копейки переводит `parseRubleAmountToKopecks`. */
  amount: freekassaNumeric,
  currency: z.string().optional(),
  date: z.string().optional(),
  status: z.coerce.number().int(),
});
export type FreekassaOrder = z.infer<typeof freekassaOrderSchema>;

export const freekassaOrdersResponseSchema = z.object({
  type: z.literal('success'),
  pages: z.number().int().optional(),
  orders: z.array(freekassaOrderSchema),
});
export type FreekassaOrdersResponse = z.infer<typeof freekassaOrdersResponseSchema>;

/**
 * Статус провайдера → наш терминальный статус заказа.
 *
 * `null` — не терминальный (новый / неизвестный код): такой заказ оставляем
 * ждать, добор попробует снова через 5 минут.
 *
 * `6` (возврат) по pending-платежу — аномалия: деньги были приняты и возвращены,
 * а мы этого не видели. Хороним как `cancelled` и алертим: восстанавливать
 * такой заказ автоматически нельзя.
 */
export function freekassaTerminalReason(status: number): 'cancelled' | 'failed' | null {
  if (status === FREEKASSA_ORDER_STATUS.ERROR) return 'failed';
  if (status === FREEKASSA_ORDER_STATUS.CANCELLED) return 'cancelled';
  if (status === FREEKASSA_ORDER_STATUS.REFUND) return 'cancelled';
  return null;
}

// ─── Уведомление об оплате (webhook) ──────────────────────────────────────

/**
 * Тело уведомления. Приходит form-data (в ЛК зафиксирован POST), поэтому ВСЕ
 * значения — строки; числами их не объявляем, иначе `AMOUNT` пришлось бы
 * приводить, а подпись считается по исходной строке (см. `sign.ts`).
 *
 * Поля из раздела 1.4 доки. `us_*` (произвольные пользовательские) не
 * объявляем — мы их не шлём; `.passthrough()` пропускает всё лишнее, чтобы
 * добавленное провайдером поле не роняло приём денег.
 *
 * ⚠️ `payer_account` — счёт/карта плательщика. В логи и в `payments.raw_payload`
 * это поле уходить не должно: см. `maskPayerAccount` ниже.
 */
export const freekassaNotificationSchema = z
  .object({
    MERCHANT_ID: z.string().min(1),
    AMOUNT: z.string().min(1),
    intid: z.string().min(1),
    MERCHANT_ORDER_ID: z.string().min(1),
    SIGN: z.string().min(1),
    P_EMAIL: z.string().optional(),
    P_PHONE: z.string().optional(),
    CUR_ID: z.string().optional(),
    payer_account: z.string().optional(),
    commission: z.string().optional(),
  })
  .passthrough();
export type FreekassaNotification = z.infer<typeof freekassaNotificationSchema>;

/**
 * Маскирование счёта плательщика перед логом/сохранением.
 *
 * Провайдер может прислать полный номер карты, а хранить или логировать PAN
 * запрещено (CLAUDE.md → «Что запрещено»). Оставляем последние 4 символа —
 * этого хватает оператору для сверки с выпиской.
 */
export function maskPayerAccount(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= 4) return '****';
  return `****${trimmed.slice(-4)}`;
}

/**
 * Полезная нагрузка уведомления, безопасная для `payments.raw_payload` и логов:
 * `payer_account` замаскирован, `SIGN` выброшен (секретного слова он не
 * раскрывает, но и пользы в хранилище от него нет).
 */
export function toStorableNotification(
  n: FreekassaNotification,
): Record<string, unknown> {
  const { SIGN: _sign, payer_account: payerAccount, ...rest } = n;
  const masked = maskPayerAccount(payerAccount);
  return {
    ...rest,
    ...(masked !== undefined ? { payer_account_masked: masked } : {}),
  };
}
