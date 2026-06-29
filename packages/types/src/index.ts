import { z } from 'zod';

export {
  telegramUpdateSchema,
  type TelegramUpdate,
  type TelegramMessage,
  type TelegramChat,
  type TelegramUser,
  type TelegramCallbackQuery,
} from './telegram.ts';

export {
  telegramWebAppUser,
  type TelegramWebAppUser,
} from './telegram-webapp.ts';

export {
  loveAndPayInvoiceStatus,
  type LoveAndPayInvoiceStatus,
  loveAndPayStatusToInternal,
  loveAndPayStatusToPaymentStatus,
  loveAndPayInvoiceRequestSchema,
  type LoveAndPayInvoiceRequest,
  loveAndPayInvoiceSchema,
  type LoveAndPayInvoice,
  loveAndPayInvoiceResponseSchema,
  type LoveAndPayInvoiceResponse,
  loveAndPayRateSchema,
  type LoveAndPayRate,
  loveAndPayRatesResponseSchema,
  type LoveAndPayRatesResponse,
  loveAndPayWebhookData,
  type LoveAndPayWebhookData,
  loveAndPayWebhookEventSchema,
  type LoveAndPayWebhookEvent,
  loveAndPayErrorCode,
  type LoveAndPayErrorCode,
  loveAndPayErrorSchema,
  type LoveAndPayError,
} from './loveandpay.ts';

export {
  paySpaceErrorSchema,
  type PaySpaceError,
  paySpaceVccCardSchema,
  type PaySpaceVccCard,
  paySpaceCreateCardDataSchema,
  type PaySpaceCreateCardData,
  paySpaceAsyncOpStatus,
  type PaySpaceAsyncOpStatus,
  paySpaceAsyncOpDataSchema,
  type PaySpaceAsyncOpData,
  paySpaceTopupCheckDataSchema,
  type PaySpaceTopupCheckData,
  paySpaceWithdrawCheckDataSchema,
  type PaySpaceWithdrawCheckData,
  paySpaceReleaseDataSchema,
  type PaySpaceReleaseData,
  paySpaceCardInfoDataSchema,
  type PaySpaceCardInfoData,
  paySpaceUserBalanceDataSchema,
  type PaySpaceUserBalanceData,
} from './paypace.ts';

// ─── Order status + state machine ─────────────────────────────────────────

export {
  orderStatus,
  type OrderStatus,
  allowedTransitions,
  isAllowedTransition,
  canTransition,
  OrderTransitionError,
} from './order-state-machine.ts';

// ─── Referral (партнёрская программа) ──────────────────────────────────────

export {
  REFERRAL_RATE_TABLE,
  REFERRAL_MAX_LEVEL,
  REFERRAL_DEFAULT_CIRCLE,
  REFERRAL_MAX_CHAIN_BPS,
  REFERRAL_DEEPLINK_PREFIX,
  referralCodeSchema,
  clampCircle,
  referralRateBps,
  referralAmountUsdCents,
  planCommissionAccruals,
  parseReferralCode,
  shouldInheritReferrerOnMerge,
  walkReferralAncestors,
  type ReferralCircleRates,
  type ReferralCode,
  type ReferralAncestor,
  type AccrualBeneficiary,
  type PlannedAccrual,
} from './referral.ts';

// ─── Order parameters (гибкая структура) ──────────────────────────────────

export const orderParameters = z.object({
  serviceSlug: z.string().optional(),
  customDescription: z.string().optional(),
  tierName: z.string().optional(),
  period: z.enum(['month', 'quarter', 'year']).optional(),
  accountEmail: z.string().email().optional(),
  region: z.string().optional(),
  // свободные поля для сервисов со специфическими требованиями
  extra: z.record(z.unknown()).optional(),
});
export type OrderParameters = z.infer<typeof orderParameters>;

// ─── Service catalog ──────────────────────────────────────────────────────

export const serviceTier = z.object({
  name: z.string(),
  period: z.enum(['month', 'quarter', 'year']),
  priceRub: z.number().int().positive(), // в копейках
  originalAmount: z.number().int().positive().optional(),
  currency: z.string().length(3).optional(),
});
export type ServiceTier = z.infer<typeof serviceTier>;

export const pricingPolicy = z.object({
  tiers: z.array(serviceTier).min(1),
  margin: z.number().min(0).max(1).optional(),
});
export type PricingPolicy = z.infer<typeof pricingPolicy>;

// ─── AI agent tool results ────────────────────────────────────────────────

export const proposeOrderInput = z.object({
  serviceSlug: z.string().optional(),
  customDescription: z.string().optional(),
  tierName: z.string().optional(),
  period: z.enum(['month', 'quarter', 'year']).optional(),
  accountEmail: z.string().email().optional(),
  notes: z.string().optional(),
});
export type ProposeOrderInput = z.infer<typeof proposeOrderInput>;

export const handoffReason = z.enum([
  'user_requested',
  'ai_uncertain',
  'kyc_complex',
  'payment_issue',
  'dispute',
  'other',
]);
export type HandoffReason = z.infer<typeof handoffReason>;

// ─── Payment / attachment / actor enums (синхронизированы с pgEnum в @oplati/db) ──

export const paymentProvider = z.enum([
  'yookassa',
  'cryptobot',
  'sbp',
  'manual',
  'loveandpay',
  'paypace',
]);
export type PaymentProvider = z.infer<typeof paymentProvider>;

export const cardStatus = z.enum(['active', 'idle', 'recycled']);
export type CardStatus = z.infer<typeof cardStatus>;

export const paymentStatus = z.enum(['pending', 'succeeded', 'failed', 'refunded']);
export type PaymentStatus = z.infer<typeof paymentStatus>;

export const attachmentKind = z.enum([
  'payment_proof',
  'kyc',
  'fulfillment_proof',
  'other',
]);
export type AttachmentKind = z.infer<typeof attachmentKind>;

export const actorType = z.enum([
  'system',
  'user',
  'operator',
  'supervisor',
  'ai',
  'payment_provider',
]);
export type ActorType = z.infer<typeof actorType>;

// ─── Payment webhook envelopes ────────────────────────────────────────────

// Внешний контракт webhook'а уже значений (yookassa | cryptobot | sbp) — оставляем
// inline, чтобы не сужать платежные провайдеры приходящие извне до 'manual'
// (manual — внутренний путь, webhook'а у него быть не должно).
export const paymentWebhookEvent = z.object({
  provider: z.enum(['yookassa', 'cryptobot', 'sbp']),
  providerRef: z.string(),
  status: z.enum(['pending', 'succeeded', 'failed']),
  amountRub: z.number().int().nonnegative(), // копейки
  raw: z.record(z.unknown()),
});
export type PaymentWebhookEvent = z.infer<typeof paymentWebhookEvent>;
