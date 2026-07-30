import { z } from 'zod';

import { paymentStatus, type PaymentStatus } from './index.ts';

/**
 * Zod-схемы интеграции Love & Pay (https://api.prod.loveandpay.io/api/v2).
 *
 * Источник правды — план `.ai-factory/plans/mvp.md` (раздел 6.5 ТЗ).
 * Точные имена полей в ответах подтверждаются при первом успешном вызове sandbox'а;
 * при расхождении обновляем схему здесь — это позволяет ловить контракт-дрифт через
 * `safeParse` на границе HTTP-клиента в `apps/web/lib/loveandpay/`.
 */

// ─── Status mapper ────────────────────────────────────────────────────────

/** Внешний статус invoice в L&P API. */
export const loveAndPayInvoiceStatus = z.enum([
  'PENDING',
  'PAID',
  'EXPIRED',
  'CANCELLED',
]);
export type LoveAndPayInvoiceStatus = z.infer<typeof loveAndPayInvoiceStatus>;

/** Маппинг L&P-статуса в наш внутренний `payment_status` enum. */
export function loveAndPayStatusToInternal(
  status: LoveAndPayInvoiceStatus,
): PaymentStatus | 'expired' | 'cancelled' {
  switch (status) {
    case 'PAID':
      return 'succeeded';
    case 'PENDING':
      return 'pending';
    case 'EXPIRED':
      return 'expired';
    case 'CANCELLED':
      return 'cancelled';
  }
}

/** То же, но возвращает только `PaymentStatus` (для записей в `payments.status`). */
export function loveAndPayStatusToPaymentStatus(
  status: LoveAndPayInvoiceStatus,
): PaymentStatus {
  const v = loveAndPayStatusToInternal(status);
  if (v === 'expired' || v === 'cancelled') return 'failed';
  return paymentStatus.parse(v);
}

// ─── Invoice create request/response ─────────────────────────────────────

/** Тело `POST /api/v2/invoices`. Все суммы — рубли (не копейки!), как требует L&P. */
export const loveAndPayInvoiceRequestSchema = z.object({
  amount: z.number().positive(),
  currency: z.literal('RUB').default('RUB'),
  description: z.string().min(1).max(255),
  customer: z.object({
    name: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
  }),
  expiresInHours: z.number().int().min(1).max(72).default(24),
  successUrl: z.string().url().optional(),
  kycRequired: z.boolean().default(false),
  /** 'sbp' | 'card'; отсутствие — провайдер сам выберет. */
  paymentMethod: z.enum(['sbp', 'card']).optional(),
});
export type LoveAndPayInvoiceRequest = z.infer<typeof loveAndPayInvoiceRequestSchema>;

export const loveAndPayInvoiceSchema = z.object({
  id: z.string(),
  invoiceNumber: z.string(),
  amount: z.number(),
  currency: z.string(),
  description: z.string().optional(),
  status: loveAndPayInvoiceStatus,
  expiresAt: z.string(), // ISO timestamp
  createdAt: z.string().optional(),
  qrCode: z.string().optional(),
  qrPayload: z.string().optional(),
  /**
   * Ссылка на оплату. Присутствует ТОЛЬКО в ответе на СОЗДАНИЕ инвойса
   * (POST /invoices). В ответе на проверку статуса (GET /invoices/{id}) поля
   * нет — поэтому optional, иначе polling-recovery (cron poll-payment) падает с
   * LoveAndPayContractError на каждом прогоне. Обязательность для create
   * форсится явным guard в `payments/create` (инвойс без ссылки непригоден).
   */
  paymentLink: z.string().url().optional(),
  originalPaymentUrl: z.string().url().optional(),
  externalOrderId: z.string().optional(),
  kycRequired: z.boolean().optional(),
  kycVerified: z.boolean().optional(),
  receiptRequired: z.boolean().optional(),
  customer: z.unknown().nullable().optional(),
});
export type LoveAndPayInvoice = z.infer<typeof loveAndPayInvoiceSchema>;

export const loveAndPayInvoiceResponseSchema = z.object({
  success: z.boolean(),
  invoice: loveAndPayInvoiceSchema,
});
export type LoveAndPayInvoiceResponse = z.infer<typeof loveAndPayInvoiceResponseSchema>;

// ─── Webhook events ───────────────────────────────────────────────────────

/**
 * Webhook L&P. Контракт снят с РЕАЛЬНОГО платежа (discovery 2026-06-09):
 *
 *   Заголовки:
 *     - `X-Webhook-Signature` — `sha256=<hex>`, где hex = HMAC-SHA256(secret, rawBody);
 *       префикс `sha256=` снимается в `apps/web/lib/loveandpay/sign.ts`.
 *     - Заголовка `X-Webhook-Event` у реального webhook'а НЕТ — тип события только в теле.
 *   Тело прода: `{ id, event: "invoice.paid", timestamp, data: { id, invoiceNumber,
 *     amount, currency, status, paidAt, ... }, partnerId, retryCount }`.
 *
 * ВАЖНО: вкладка «Тестирование» в кабинете L&P шлёт ДРУГОЙ (не продовый) формат —
 * `event: "INVOICE_PAID"`, `data.invoiceId` (без `currency`). Чтобы и тестовая панель,
 * и реальные webhook'и парсились, схема принимает оба:
 *   - событие: `INVOICE_PAID` нормализуется в `invoice.paid` (и т.д.);
 *   - id: `invoiceId` нормализуется в `id`; `currency` по умолчанию `RUB`.
 *
 * Хендлеры и cron `poll-payment` работают с единым типом `LoveAndPayWebhookData`
 * ({ id, invoiceNumber, amount, currency, status }).
 */
/**
 * Единый вид данных счёта для хендлеров — общий для webhook-пути и polling-пути
 * (`poll-payment` строит его из ответа `getInvoice`). Тип объявлен явно, а не через
 * `z.infer`, ради опционального `amountKopecks`: у polling-пути и легаси-вебхуков
 * этого поля нет, и требовать его от каждого конструктора было бы шумом.
 */
export type LoveAndPayWebhookData = {
  id: string;
  invoiceNumber: string;
  /** Сумма как её прислал провайдер. В `invoice.paid` — рубли. */
  amount: number;
  /** Однозначные копейки, если провайдер их прислал. См. transform ниже. */
  amountKopecks?: number;
  currency: string;
  status: LoveAndPayInvoiceStatus;
};

/** Копейки принимаются только как положительное целое; всё остальное — «нет данных». */
function positiveKopecks(v: number | undefined): number | undefined {
  return v !== undefined && Number.isInteger(v) && v > 0 ? v : undefined;
}

export const loveAndPayWebhookData = z
  .object({
    id: z.string().optional(),
    invoiceId: z.string().optional(),
    invoiceNumber: z.string(),
    amount: z.number().optional(),
    // Однозначные поля новой платформы (2026-07-29). См. `amountKopecks` в transform:
    // сам `amount` провайдер объявил исторически неоднозначным.
    //
    // `.positive()` — чтобы мусор (0, отрицательное, дробные копейки) не выдавал себя
    // за точную сумму: такие значения отбрасываются как отсутствующие, и потребитель
    // падает на легаси-`amount`. Гейт недоплаты сверку нулевой суммы пропускает
    // (осознанное fail-open, см. `handlers.ts`), поэтому фальшивая точность здесь
    // опаснее её отсутствия.
    amountKopecks: z.number().int().positive().optional().catch(undefined),
    amountRub: z.number().positive().optional().catch(undefined),
    currency: z.string().optional(),
    status: loveAndPayInvoiceStatus,
    paidAt: z.string().optional(),
  })
  // Без хотя бы одного id дальше работать нельзя: пустой `id` сломал бы
  // идемпотентность платежей (provider_ref = ''). Падаем на границе парсинга.
  .refine((d) => Boolean(d.id ?? d.invoiceId), {
    message: 'either id or invoiceId must be provided',
  })
  .transform((d): LoveAndPayWebhookData => ({
    id: d.id ?? d.invoiceId ?? '',
    invoiceNumber: d.invoiceNumber,
    amount: d.amount ?? 0,
    /**
     * Сумма в копейках, если провайдер прислал её ОДНОЗНАЧНО.
     *
     * Документация новой платформы (кабинет → Вебхуки, 2026-07-29) прямо
     * предупреждает: `amount` в `invoice.created` приходит в копейках, а в
     * остальных событиях — в рублях («так сложилось исторически»), и опираться
     * следует на `amountKopecks`/`amountRub`. Для нас цена ошибки максимальная:
     * недоплата ТЕРМИНАЛЬНА (заказ → failed + DM владельцу), поэтому смена
     * семантики `amount` уронила бы каждый платёж.
     *
     * `undefined` — когда однозначных полей в теле нет (легаси-вебхуки, тестовая
     * панель кабинета, а также polling-путь, который строит эти данные из ответа
     * `getInvoice` вручную) ЛИБО когда они не дают положительной суммы в копейках
     * (например `amountRub: 0.004` округлился бы в 0). Тогда потребитель падает
     * обратно на `amount` в рублях — лучше честное отсутствие, чем фальшивый ноль,
     * который гейт недоплаты пропускает как «нечего сравнивать».
     */
    amountKopecks: positiveKopecks(
      d.amountKopecks ?? (d.amountRub !== undefined ? Math.round(d.amountRub * 100) : undefined),
    ),
    currency: d.currency ?? 'RUB',
    status: d.status,
  }));

/** Канонические имена событий (прод). Тестовая панель шлёт UPPER_SNAKE — алиасим. */
const loveAndPayEventAliases: Record<string, string> = {
  INVOICE_CREATED: 'invoice.created',
  INVOICE_PAID: 'invoice.paid',
  INVOICE_EXPIRED: 'invoice.expired',
  INVOICE_CANCELLED: 'invoice.cancelled',
};

const loveAndPayWebhookEventName = z.preprocess(
  (v) => (typeof v === 'string' && v in loveAndPayEventAliases ? loveAndPayEventAliases[v] : v),
  z.enum(['invoice.created', 'invoice.paid', 'invoice.expired', 'invoice.cancelled']),
);

export const loveAndPayWebhookEventSchema = z.object({
  event: loveAndPayWebhookEventName,
  timestamp: z.string().optional(),
  data: loveAndPayWebhookData,
});
export type LoveAndPayWebhookEvent = z.infer<typeof loveAndPayWebhookEventSchema>;

// ─── Errors ───────────────────────────────────────────────────────────────

export const loveAndPayErrorCode = z.enum([
  'INVALID_SIGNATURE',
  'TIMESTAMP_EXPIRED',
  'RATE_LIMIT_EXCEEDED',
  'CYCLE_BLOCKED',
  'VALIDATION_ERROR',
  'PARTNER_INACTIVE',
  'API_BLOCKED',
  'INTERNAL_ERROR',
]);
export type LoveAndPayErrorCode = z.infer<typeof loveAndPayErrorCode>;

export const loveAndPayErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: loveAndPayErrorCode.or(z.string()),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});
export type LoveAndPayError = z.infer<typeof loveAndPayErrorSchema>;
