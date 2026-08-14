export {
  getOrCreateUserByTelegramId,
  getOrCreateUserByWebSessionId,
  getUserTelegramId,
  getUserProfileById,
  findUserIdByWebSessionId,
  isWebSessionLinkedToTelegram,
  getWebSessionProfile,
  type UserProfile,
  type WebSessionProfile,
  type GetOrCreateUserByTelegramIdInput,
  type GetOrCreateUserByTelegramIdResult,
  type GetOrCreateUserByWebSessionIdInput,
  type GetOrCreateUserByWebSessionIdResult,
} from './users.ts';

export {
  getOrCreateActiveConversation,
  findActiveConversation,
  createConversation,
  type GetOrCreateActiveConversationInput,
  type GetOrCreateActiveConversationResult,
} from './conversations.ts';

export {
  appendMessage,
  deleteOldMessages,
  getLastAssistantMessageMeta,
  loadRecentMessages,
  type AppendMessageInput,
  type AppendMessageResult,
  type MessageHistoryItem,
} from './messages.ts';

export {
  createLinkToken,
  consumeLinkToken,
  deleteExpiredLinkTokens,
  LINK_TOKEN_PREFIX,
  type CreateLinkTokenInput,
  type CreateLinkTokenResult,
  type ConsumeLinkTokenInput,
  type ConsumeLinkTokenResult,
} from './link-tokens.ts';

export { noopLogger, type RepoLogger } from './logger.ts';

export {
  recordAiUsageDelta,
  getAiUsageForDay,
  utcDayKey,
  type AiUsageDelta,
  type AiUsageTotals,
} from './ai-usage.ts';

export { getAppliedMigrations, pingDb, type AppliedMigrations } from './health.ts';

export { nextFreekassaNonce } from './freekassa.ts';

export {
  generateReferralCode,
  resolveReferralCode,
  ensureReferralCode,
  setReferrerOnce,
  getReferralAncestors,
  type SetReferrerResult,
} from './referrals.ts';

export {
  getPartnerProfile,
  insertCommissionAccruals,
  getReferralBalanceUsdCents,
  orderHasAccruals,
  reverseAccrualsForOrder,
  findOrdersMissingReferralAccruals,
  type PartnerProfile,
  type CommissionAccrualInsert,
  type OrderMissingAccrual,
} from './referral-accruals.ts';

export {
  getReferralNetwork,
  getReferralIncome,
  getReferralEarnings,
  getReferralMonthlyIncome,
  getNewReferralsThisMonth,
  getReferralLedger,
  getReferralPayouts,
  createReferralPayout,
  transitionReferralPayout,
  type CreateReferralPayoutResult,
  type CreateReferralPayoutOptions,
  type TransitionReferralPayoutResult,
  type ReferralNetworkSummary,
  type ReferralIncome,
  type ReferralEarnings,
  type ReferralMonthlyIncomePoint,
  type ReferralNewReferrals,
  type ReferralLedgerRow,
  type ReferralPayoutRow,
} from './referral-cabinet.ts';

export {
  listReferralRollupCandidates,
  getLatestRolledUpMonth,
  getMonthlyRollupInput,
  getPriorConsecutiveMetMonths,
  applyMonthlyProgression,
  type MonthlyRollupInput,
  type ApplyMonthlyProgressionParams,
  type ApplyMonthlyProgressionResult,
} from './referral-progression.ts';

export {
  createCard,
  findActiveByUserId,
  findCardsByUserIdForCabinet,
  findCardByIdForUser,
  markIdle,
  markRecycled,
  updateBalance,
  syncCardBalance,
  findCardsToRecycle,
  type Card,
  type CreateCardInput,
} from './cards.ts';

export {
  createDraftOrder,
  getOrderById,
  getOrdersByUserId,
  getOrderEventsByOrderId,
  transitionOrder,
  transitionOrderDetailed,
  setOrderCardId,
  setOrderExpiresAt,
  findExpiredPayableOrders,
  findStuckPaidOrders,
  findStuckInFulfillmentOrders,
  findOrdersForRenewalReminder,
  appendOrderEvent,
  claimRenewalReminder,
  hasRecentOrderEvent,
  countRecentOrdersByUser,
  hasPurchasedOrders,
  type OrderRow,
  type OrderEventRow,
  type CreateDraftOrderInput,
  type TransitionOrderInput,
  type TransitionOrderResult,
} from './orders.ts';

export {
  upsertPaymentByProviderRef,
  claimPaymentSucceeded,
  claimPaymentTerminal,
  findPendingPaymentsForPoll,
  findPaymentByProviderRef,
  findPaymentByProviderInvoiceNumber,
  countInvoiceConversion,
  type InvoiceConversion,
  findPendingPaymentByOrderId,
  stripOldPaymentPayloads,
  findPaymentsByOrderId,
  type PaymentRow,
  type UpsertPaymentByProviderRefInput,
  type UpsertResult,
  type MarkPaymentSucceededInput,
} from './payments.ts';

export {
  searchActiveServices,
  listActiveServices,
  getServiceById,
  getServiceBySlug,
  getServicesByIds,
  type ServiceRow,
  type CatalogSearchItem,
} from './services.ts';

export {
  findVpnSubscriptionByUserId,
  upsertVpnSubscription,
  type VpnSubscription,
  type UpsertVpnSubscriptionInput,
} from './vpn-subscriptions.ts';

export {
  insertAnalyticsEvents,
  syncAnalyticsDictionary,
  deleteOldAnalyticsEvents,
  analyticsEventsStats,
  countAnalyticsEventsByTelegramId,
  type AnalyticsEventInsert,
  type AnalyticsDictionaryRow,
} from './analytics.ts';
