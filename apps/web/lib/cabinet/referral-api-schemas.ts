import { z } from 'zod';

import type { ReferralSnapshot } from './referral-types.ts';

/**
 * Zod-схемы ответов `POST /api/cabinet/referral` — общий контракт клиента
 * (`components/partner/partner-api.ts`, обе поверхности: сайт `/partner` и
 * мини-апп) и сервера (M-9 аудита: раньше клиент кастил ответы `as`, при том
 * что близнец `cabinet-api.ts` парсит схемами).
 *
 * Зеркалят view-типы `referral-types.ts`; совпадение форсится компилятором
 * через `satisfies` внизу. Числа — без `.int()`: как в `cabinet-api.ts`,
 * чтобы косметический дрейф сервера не превращался в отказ всего кабинета.
 * Модуль client-safe: только `zod` + type-only импорт.
 */

const circleViewSchema = z.object({
  circle: z.number(),
  label: z.string(),
  nextLabel: z.string().nullable(),
  nextThresholdUsdCents: z.number().nullable(),
  achievementBonusUsdCents: z.number(),
});

const ratesViewSchema = z.object({
  l1Bps: z.number(),
  topL1Bps: z.number(),
});

const networkViewSchema = z.object({
  total: z.number(),
  active: z.number(),
  turnoverThisMonthUsdCents: z.number(),
  incomeThisMonthUsdCents: z.number(),
  incomeAllTimeUsdCents: z.number(),
});

const progressViewSchema = z.object({
  networkTurnoverThisMonthUsdCents: z.number(),
  nextThresholdUsdCents: z.number().nullable(),
  progressBps: z.number(),
});

const sprintViewSchema = z.object({
  newReferralsThisMonth: z.number(),
  newReferralsActive: z.number(),
  newReferralsGoal: z.number(),
  turnoverThisMonthUsdCents: z.number(),
  turnoverBoostThresholdUsdCents: z.number(),
});

const historyEntrySchema = z.object({
  kind: z.enum([
    'commission',
    'circle_bonus',
    'sprint_new_refs',
    'sprint_turnover_boost',
    'serial_bonus',
    'payout',
  ]),
  title: z.string(),
  subtitle: z.string(),
  amountUsdCents: z.number(),
  status: z.string(),
  statusLabel: z.string(),
  reversed: z.boolean(),
  at: z.string(),
});

export const referralSnapshotSchema = z.object({
  enabled: z.boolean(),
  suspended: z.boolean(),
  telegramLinked: z.boolean(),
  referralCode: z.string().nullable(),
  telegramLink: z.string().nullable(),
  circle: circleViewSchema,
  rates: ratesViewSchema,
  rateLockedForever: z.boolean(),
  earnedThisMonthUsdCents: z.number(),
  earnedTotalUsdCents: z.number(),
  balanceUsdCents: z.number(),
  minPayoutUsdCents: z.number(),
  canPayout: z.boolean(),
  progress: progressViewSchema,
  sprint: sprintViewSchema,
  network: networkViewSchema,
  monthlyIncome: z.array(z.object({ month: z.string(), usdCents: z.number() })),
  history: z.array(historyEntrySchema),
}) satisfies z.ZodType<ReferralSnapshot>;

/** Успех `action: 'snapshot'`. Ошибки ловит `referralErrorResponseSchema`. */
export const referralSnapshotResponseSchema = z.object({
  ok: z.literal(true),
  snapshot: referralSnapshotSchema,
});

/**
 * `action: 'payout'` — зеркало `RequestPayoutResult` (referral-actions.ts) в
 * границах, которые использует UI: серверные feeUsdCents/netUsdCents клиент
 * не читает, Zod их отбрасывает.
 */
export const referralPayoutResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    payoutId: z.string(),
    amountUsdCents: z.number(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    minPayoutUsdCents: z.number().optional(),
    balanceUsdCents: z.number().optional(),
  }),
]);

/** Любой ошибочный ответ роута (`invalid_json`, auth, rate-limit, 500). */
export const referralErrorResponseSchema = z.object({ error: z.string() });

export type ReferralPayoutResponse = z.infer<typeof referralPayoutResponseSchema>;
