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
  getLastAssistantMessageMeta,
  loadRecentMessages,
  type AppendMessageInput,
  type AppendMessageResult,
  type MessageHistoryItem,
} from './messages.ts';

export {
  createLinkToken,
  consumeLinkToken,
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

export { pingDb } from './health.ts';

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
  findOrdersMissingReferralAccruals,
  type PartnerProfile,
  type CommissionAccrualInsert,
  type OrderMissingAccrual,
} from './referral-accruals.ts';

export {
  getReferralNetwork,
  getReferralIncomeByLevel,
  getReferralEarnings,
  getReferralMonthlyIncome,
  getNewReferralsThisMonth,
  getReferralLedger,
  getReferralPayouts,
  createReferralPayout,
  type ReferralNetworkLevel,
  type ReferralLevelIncome,
  type ReferralEarnings,
  type ReferralMonthlyIncomePoint,
  type ReferralNewReferrals,
  type ReferralLedgerRow,
  type ReferralPayoutRow,
} from './referral-cabinet.ts';

export {
  createCard,
  findActiveByUserId,
  findCardsByUserIdForCabinet,
  findRecyclableCard,
  markIdle,
  markRecycled,
  markActive,
  updateBalance,
  idleAgedActiveCards,
  findCardsToRecycle,
  type Card,
  type CreateCardInput,
} from './cards.ts';

export {
  createDraftOrder,
  getOrderById,
  getOrderByShortId,
  getOrdersByUserId,
  getOrderEventsByOrderId,
  transitionOrder,
  transitionOrderDetailed,
  setOrderCardId,
  findExpiredPendingOrders,
  findStuckPaidOrders,
  findStuckInFulfillmentOrders,
  findOrdersForRenewalReminder,
  hasRecentOrderEvent,
  countRecentOrdersByUser,
  type OrderRow,
  type OrderEventRow,
  type CreateDraftOrderInput,
  type TransitionOrderInput,
  type TransitionOrderResult,
} from './orders.ts';

export {
  upsertPaymentByProviderRef,
  markPaymentSucceeded,
  claimPaymentSucceeded,
  markPaymentStatus,
  findPendingPaymentsForPoll,
  findPaymentByProviderRef,
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
