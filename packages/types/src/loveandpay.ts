import { z } from 'zod';

import { paymentStatus, type PaymentStatus } from './index.ts';

/**
 * Zod-схемы интеграции Love & Pay (https://loveandpay.io/api/v2).
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

// ─── Rates ────────────────────────────────────────────────────────────────

/**
 * Ответ `GET /api/v2/rates?base=USDT&quote=RUB` (см. docs.loveandpay.io
 * → api-reference/v2/rates/current). Реальная структура — `rate` это объект,
 * а число лежит в `rate.rate`.
 */
export const loveAndPayRateSchema = z.object({
  id: z.string(),
  baseCurrency: z.string(),
  quoteCurrency: z.string(),
  rate: z.number().positive(),
  validFrom: z.string().optional(),
  validTo: z.string().nullable().optional(),
  fixedAt: z.string().optional(),
});
export type LoveAndPayRate = z.infer<typeof loveAndPayRateSchema>;

export const loveAndPayRatesResponseSchema = z.object({
  success: z.boolean().optional(),
  rate: loveAndPayRateSchema,
  formatted: z
    .object({
      pair: z.string().optional(),
      value: z.string().optional(),
    })
    .optional(),
  requestId: z.string().optional(),
});
export type LoveAndPayRatesResponse = z.infer<typeof loveAndPayRatesResponseSchema>;

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
export const loveAndPayWebhookData = z
  .object({
    id: z.string().optional(),
    invoiceId: z.string().optional(),
    invoiceNumber: z.string(),
    amount: z.number().optional(),
    currency: z.string().optional(),
    status: loveAndPayInvoiceStatus,
    paidAt: z.string().optional(),
  })
  // Без хотя бы одного id дальше работать нельзя: пустой `id` сломал бы
  // идемпотентность платежей (provider_ref = ''). Падаем на границе парсинга.
  .refine((d) => Boolean(d.id ?? d.invoiceId), {
    message: 'either id or invoiceId must be provided',
  })
  .transform((d) => ({
    id: d.id ?? d.invoiceId ?? '',
    invoiceNumber: d.invoiceNumber,
    amount: d.amount ?? 0,
    currency: d.currency ?? 'RUB',
    status: d.status,
  }));
export type LoveAndPayWebhookData = z.infer<typeof loveAndPayWebhookData>;

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
