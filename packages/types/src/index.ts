import { z } from 'zod';

// ─── Order status ─────────────────────────────────────────────────────────

export const orderStatus = z.enum([
  'draft',
  'clarifying',
  'kyc_required',
  'ready_for_payment',
  'pending_payment',
  'paid',
  'in_fulfillment',
  'completed',
  'failed',
  'cancelled',
  'expired',
  'refund_requested',
  'refunded',
]);
export type OrderStatus = z.infer<typeof orderStatus>;

/**
 * Допустимые переходы state machine заказа.
 * Любой переход, не перечисленный здесь, — баг.
 */
export const allowedTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ['clarifying', 'cancelled'],
  clarifying: ['kyc_required', 'ready_for_payment', 'cancelled'],
  kyc_required: ['clarifying', 'cancelled'],
  ready_for_payment: ['pending_payment', 'cancelled'],
  pending_payment: ['paid', 'expired', 'cancelled'],
  paid: ['in_fulfillment', 'refund_requested'],
  in_fulfillment: ['completed', 'failed'],
  completed: ['refund_requested'],
  failed: ['refund_requested'],
  refund_requested: ['refunded', 'cancelled'],
  refunded: [],
  cancelled: [],
  expired: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (allowedTransitions[from] as readonly OrderStatus[]).includes(to);
}

// ─── Order parameters (гибкая структура) ──────────────────────────────────

export const orderParameters = z.object({
  serviceSlug: z.string().optional(),
  customDescription: z.string().optional(),
  tierName: z.string().optional(),
  period: z.enum(['month', 'year']).optional(),
  accountEmail: z.string().email().optional(),
  region: z.string().optional(),
  // свободные поля для сервисов со специфическими требованиями
  extra: z.record(z.unknown()).optional(),
});
export type OrderParameters = z.infer<typeof orderParameters>;

// ─── Service catalog ──────────────────────────────────────────────────────

export const serviceTier = z.object({
  name: z.string(),
  period: z.enum(['month', 'year']),
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
  period: z.enum(['month', 'year']).optional(),
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

// ─── Payment webhook envelopes ────────────────────────────────────────────

export const paymentWebhookEvent = z.object({
  provider: z.enum(['yookassa', 'cryptobot', 'sbp']),
  providerRef: z.string(),
  status: z.enum(['pending', 'succeeded', 'failed']),
  amountRub: z.number().int().nonnegative(), // копейки
  raw: z.record(z.unknown()),
});
export type PaymentWebhookEvent = z.infer<typeof paymentWebhookEvent>;
