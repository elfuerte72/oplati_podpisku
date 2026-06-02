import { z } from 'zod';

/**
 * Zod-схемы интеграции app.pay.space — выпуск виртуальных USD-карт.
 *
 * Точный контракт API app.pay.space в TZ.md не приведён — схема согласована по
 * разделу 6.2 плана и пройдёт верификацию при первом успешном вызове sandbox'а.
 * При расхождении обновляем здесь — `safeParse` в `apps/web/lib/pay-space/client.ts`
 * будет ловить дрифт.
 *
 * Все суммы — USD-центы (integer), никогда не numeric/float.
 */

// ─── Create card ──────────────────────────────────────────────────────────

export const paySpaceCreateCardRequestSchema = z.object({
  accountId: z.string(),
  /** Внутренний UUID нашего user (для трассировки в кабинете paypace). */
  externalUserId: z.string(),
  /** Начальный баланс в USD-центах. */
  initialBalanceUsdCents: z.number().int().nonnegative(),
});
export type PaySpaceCreateCardRequest = z.infer<typeof paySpaceCreateCardRequestSchema>;

export const paySpaceCreateCardResponseSchema = z.object({
  cardId: z.string(),
  /** Полный PAN — НИКОГДА не логировать. */
  pan: z.string(),
  panMasked: z.string(),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int(),
  /** CVC — НИКОГДА не логировать; передаётся пользователю в Telegram сообщением. */
  cvc: z.string(),
  balanceUsdCents: z.number().int().nonnegative(),
});
export type PaySpaceCreateCardResponse = z.infer<typeof paySpaceCreateCardResponseSchema>;

// ─── Top-up ──────────────────────────────────────────────────────────────

export const paySpaceTopupRequestSchema = z.object({
  cardId: z.string(),
  amountUsdCents: z.number().int().positive(),
});
export type PaySpaceTopupRequest = z.infer<typeof paySpaceTopupRequestSchema>;

export const paySpaceTopupResponseSchema = z.object({
  cardId: z.string(),
  balanceUsdCents: z.number().int().nonnegative(),
});
export type PaySpaceTopupResponse = z.infer<typeof paySpaceTopupResponseSchema>;

// ─── Get card ────────────────────────────────────────────────────────────

export const paySpaceCardStatus = z.enum(['active', 'blocked', 'expired']);
export type PaySpaceCardStatus = z.infer<typeof paySpaceCardStatus>;

export const paySpaceGetCardResponseSchema = z.object({
  cardId: z.string(),
  panMasked: z.string(),
  status: paySpaceCardStatus,
  balanceUsdCents: z.number().int().nonnegative(),
});
export type PaySpaceGetCardResponse = z.infer<typeof paySpaceGetCardResponseSchema>;

// ─── Errors ──────────────────────────────────────────────────────────────

export const paySpaceErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type PaySpaceError = z.infer<typeof paySpaceErrorSchema>;
