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
  FREEKASSA_API_BASE_URL,
  FREEKASSA_METHOD_SBP,
  FREEKASSA_METHOD_CARD_RUB,
  FREEKASSA_NOTIFICATION_IPS,
  parseRubleAmountToKopecks,
  kopecksToRubleAmount,
  freekassaCreateOrderParamsSchema,
  type FreekassaCreateOrderParams,
  freekassaCreateOrderResponseSchema,
  type FreekassaCreateOrderResponse,
  freekassaErrorResponseSchema,
  type FreekassaErrorResponse,
  freekassaNotificationSchema,
  type FreekassaNotification,
  maskPayerAccount,
  toStorableNotification,
  FREEKASSA_ORDER_STATUS,
  freekassaOrderSchema,
  type FreekassaOrder,
  freekassaOrdersResponseSchema,
  type FreekassaOrdersResponse,
  freekassaTerminalReason,
} from './freekassa.ts';

export {
  rapiraMarketRateSchema,
  type RapiraMarketRate,
  rapiraMarketRatesResponseSchema,
  type RapiraMarketRatesResponse,
} from './rapira.ts';

export {
  remnawaveUserStatus,
  type RemnawaveUserStatus,
  remnawaveUserSchema,
  type RemnawaveUser,
  remnawaveUsersByTelegramIdResponseSchema,
  remnawaveUserResponseSchema,
  remnawaveDeleteResponseSchema,
} from './remnawave.ts';

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
  OrderTransitionError,
} from './order-state-machine.ts';

// ─── Жизненный цикл виртуальной карты ─────────────────────────────────────

export {
  CARD_LIFETIME_DAYS,
  CARD_TOPUP_SAFETY_DAYS,
  isCardTopupSafe,
} from './card-lifecycle.ts';

// ─── Ответы инструментов агента (карточки веб-чата) ───────────────────────

export {
  chatToolCallSchema,
  chatToolInputSchema,
  confirmOrderOutputSchema,
  proposeOrderOutputSchema,
  requestHumanOutputSchema,
  searchCatalogItemSchema,
  toolErrorOutputSchema,
  TELEGRAM_LINK_REQUIRED_MARKER,
  type ChatToolCall,
} from './tool-outputs.ts';

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
  effectiveReferralRates,
  parseReferralCode,
  shouldInheritReferrerOnMerge,
  walkReferralAncestors,
  type ReferralCircleRates,
  type ReferralCode,
  type ReferralAncestor,
  type AccrualBeneficiary,
  type PlannedAccrual,
  type EffectiveReferralRates,
} from './referral.ts';

export {
  REFERRAL_SPRINT_NEW_REFS_GOAL,
  REFERRAL_SPRINT_NEW_REFS_BONUS_USD_CENTS,
  REFERRAL_TURNOVER_BOOST_RATIO_PERCENT,
  REFERRAL_TURNOVER_BOOST_BPS,
  REFERRAL_SERIAL_PERIOD_MONTHS,
  REFERRAL_SERIAL_BONUS_USD_CENTS,
  highestCircleForTurnover,
  planThresholdUsdCents,
  planMonthlyProgression,
  type MonthlyProgressionInput,
  type MonthlyProgressionResult,
  type ProgressionBonus,
  type ProgressionBonusKind,
} from './referral-progression.ts';

export {
  PAYOUT_METHODS,
  REFERRAL_PAYOUT_FEE_BPS,
  computePayoutFee,
  isValidLuhn,
  maskPan,
  USDT_NETWORKS,
  payoutDestinationInputSchema,
  payoutDestinationStoredSchema,
  toStoredPayoutDestination,
  PAYOUT_STATUSES,
  PAYOUT_ALLOWED_TRANSITIONS,
  canTransitionPayout,
  isTerminalPayoutStatus,
  type PayoutMethod,
  type UsdtNetwork,
  type PayoutDestinationInput,
  type PayoutDestinationStored,
  type PayoutStatus,
} from './referral-payout.ts';

// ─── Поведенческая аналитика ──────────────────────────────────────────────

export {
  ANALYTICS_CHANNELS,
  analyticsChannel,
  ANALYTICS_ORIGINS,
  analyticsOrigin,
  ANALYTICS_EVENTS,
  ANALYTICS_EVENT_NAMES,
  analyticsEventName,
  CLIENT_EVENT_NAMES,
  isClientTrackable,
  ANALYTICS_MILESTONES,
  ANALYTICS_FUNNEL,
  ANALYTICS_PROP_KEYS,
  ANALYTICS_MAX_PROPS,
  ANALYTICS_MAX_PROP_LENGTH,
  ANALYTICS_MAX_BATCH,
  ANALYTICS_MAX_CLOCK_SKEW_MS,
  sanitizeAnalyticsProps,
  analyticsIngestEventSchema,
  analyticsIngestBatchSchema,
  resolveOccurredAt,
  analyticsDictionaryRows,
  type AnalyticsChannel,
  type AnalyticsOrigin,
  type AnalyticsEventName,
  type AnalyticsMilestoneName,
  type AnalyticsPropKey,
  type AnalyticsProps,
  type AnalyticsIngestEvent,
  type AnalyticsIngestBatch,
} from './analytics.ts';

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

/**
 * Проверка, что тарифы сервиса различимы ОБОИМИ ключами, по которым их ищут.
 *
 * Ключей два, и они разные:
 *   - `(period, originalAmount)` — стабильный ключ inline-кнопки Telegram
 *     (`tier:<slug>:<period>:<usdCents>`, L-20). Дубль пары даёт кнопке ДРУГОЙ
 *     тариф при верной цене;
 *   - `(name, period)` — по нему матчит `proposeFromCatalog` (веб и Mini App).
 *     Дубль пары означает, что `find` возьмёт ПЕРВЫЙ подходящий, и клиент
 *     оформит заказ по чужой цене (аудит 2026-08-10). Сид проверял только
 *     первый ключ, поэтому такой дубль проходил насквозь.
 *
 * Бросает при первом дубле: seed обязан падать, а не завозить в прод каталог,
 * где кнопка и цена расходятся.
 */
export function assertUniqueTierKeys(slug: string, tiers: readonly ServiceTier[]): void {
  const byButtonKey = new Set<string>();
  const byMatchKey = new Set<string>();
  for (const t of tiers) {
    const buttonKey = `${t.period}:${t.originalAmount ?? 0}`;
    if (byButtonKey.has(buttonKey)) {
      throw new Error(
        `seed: у сервиса ${slug} два тарифа с одинаковым (period, originalAmount)=${buttonKey} — ключ кнопки Telegram неоднозначен (L-20)`,
      );
    }
    byButtonKey.add(buttonKey);

    const matchKey = `${t.name}:${t.period}`;
    if (byMatchKey.has(matchKey)) {
      throw new Error(
        `seed: у сервиса ${slug} два тарифа с одинаковым (name, period)=${matchKey} — по этому ключу заказ ищет тариф в вебе и Mini App, и клиент получит цену первого совпавшего`,
      );
    }
    byMatchKey.add(matchKey);
  }
}

/**
 * Пер-сервисные правила оплаты на сайте сервиса (ТЗ «клиентский путь» 2026-07):
 * VPN нельзя показывать общим советом — для каждого сервиса храним отдельные
 * требования. Лежат в `services.payment_instructions` (jsonb, nullable —
 * сервис без записи получает generic-подсказку на витрине). Данные публичные
 * (каталог под public-read RLS), секретов здесь быть не может.
 */
export const servicePaymentInstructions = z.object({
  /** Нужен ли VPN для оплаты на сайте сервиса. */
  requiresVpn: z.boolean(),
  /** Локация VPN (показывается клиенту), напр. «США». */
  vpnLocation: z.string().max(100).optional(),
  /** Валюта, которая должна отображаться на сайте сервиса, напр. «USD». */
  requiredCurrency: z.string().max(10).optional(),
  /** Что вводить в Billing Address на сайте сервиса. */
  billingInstructions: z.string().max(1000).optional(),
  /** Прямая ссылка на страницу оплаты/подписки сервиса (только https). */
  paymentUrl: z.string().url().startsWith('https://').max(500).optional(),
  /** Дополнительные особенности оплаты этого сервиса. */
  paymentNotes: z.string().max(1000).optional(),
});
export type ServicePaymentInstructions = z.infer<typeof servicePaymentInstructions>;

// ─── AI agent tool results ────────────────────────────────────────────────

/**
 * Zod-схемы входов AI-tools. Границы (`.max()` на строках) валидируют сырой
 * `tool_use.input` от модели ДО вызова обработчика (инвариант «Zod на всех
 * границах»): ограничения в `input_schema` — advisory (Anthropic их не форсит),
 * а обработчики проверяют только бизнес-логику. Схемы обязаны совпадать с
 * интерфейсом `ToolHandlers` в `@oplati/agent`.
 */
export const searchCatalogInput = z.object({
  query: z.string().min(1).max(200),
});
export type SearchCatalogInput = z.infer<typeof searchCatalogInput>;

export const proposeOrderInput = z.object({
  serviceId: z.string().max(100).optional(),
  customDescription: z.string().max(500).optional(),
  serviceName: z.string().max(100).optional(),
  amountUsdCents: z.number().int().positive(),
  paymentMethod: z.enum(['sbp', 'card']).optional(),
});
export type ProposeOrderInput = z.infer<typeof proposeOrderInput>;

export const confirmOrderInput = z.object({
  orderId: z.string().min(1).max(100),
  paymentMethod: z.enum(['sbp', 'card']).optional(),
});
export type ConfirmOrderInput = z.infer<typeof confirmOrderInput>;

export const requestHumanInput = z.object({
  orderId: z.string().max(100).nullable().default(null),
  reason: z.string().min(1).max(2000),
});
export type RequestHumanInput = z.infer<typeof requestHumanInput>;

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
  'freekassa',
]);
export type PaymentProvider = z.infer<typeof paymentProvider>;

/**
 * Шлюзы приёма рублей, между которыми переключается `PAYMENT_PRIMARY_PROVIDER`.
 * Подмножество `paymentProvider`: `paypace` выпускает карты (не принимает
 * деньги), `manual`/`sbp`/`yookassa`/`cryptobot` — исторические значения.
 *
 * Строковый enum, а НЕ булев флаг вида `FREEKASSA_ACTIVE`: опечатка в значении
 * роняет валидацию env при старте, тогда как `FREEKASSA_ACTIVE=True` наивная
 * проверка `=== 'true'` прочитала бы как «выключено» и деньги молча пошли бы
 * через другой шлюз (разбор в ТЗ, «Этап 3»).
 */
export const paymentGateway = z.enum(['loveandpay', 'freekassa']);
export type PaymentGateway = z.infer<typeof paymentGateway>;

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
