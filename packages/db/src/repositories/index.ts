export {
  getOrCreateUserByTelegramId,
  getOrCreateUserByWebSessionId,
  getUserTelegramId,
  getUserPayerContact,
  touchUserLastSeenIp,
  updateUserContacts,
  getPayerPhoneForOrder,
  getUserProfileById,
  type UserPayerContact,
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
  countSupportAiReplies,
  findExpiredOperatorConversations,
  findLastStaffFollowUpAt,
  findUnansweredSupportConversations,
  getConversationState,
  loadSupportHistory,
  touchConversationMode,
  transitionConversationMode,
  type ConversationState,
  type SupportConversationRef,
  type TransitionConversationModeInput,
  type TransitionConversationModeResult,
  type UnansweredSupportConversation,
} from './support.ts';

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
  findOrdersWithUnreversedAccruals,
  findPurchasedOrdersWithReversedAccruals,
  findNegativeReferralBalances,
  findOrdersMissingReferralAccruals,
  type PartnerProfile,
  type CommissionAccrualInsert,
  type OrderMissingAccrual,
  type UnreversedAccrualOrder,
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
  findReferralPayoutForPanel,
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
  findOrdersCommittingCardFund,
  findStaleOrdersInPaymentReview,
  findStuckPaidOrders,
  findStuckInFulfillmentOrders,
  findOrdersForRenewalReminder,
  appendOrderEvent,
  PAYMENT_REVIEW_CLIENT_NOTIFIED_EVENT,
  PAYMENT_REMINDER_SENT_EVENT,
  PAYMENT_REMINDER_FAILED_EVENT,
  PAYMENT_BLOCKED_CAPACITY_EVENT,
  claimPaymentReminder,
  claimRenewalReminder,
  hasRecentOrderEvent,
  countRecentOrdersByUser,
  countRefundishHistoryByUser,
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
  setPaymentProviderStatus,
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

export {
  ASSIGNABLE_STAFF_ROLES,
  claimStaffTotpStep,
  confirmStaffTotp,
  findStaffById,
  findStaffByTelegramId,
  listStaff,
  listStaffRecipients,
  resetStaffTotpByTelegramId,
  setStaffActiveByTelegramId,
  startStaffTotpEnrollment,
  touchStaffLastLogin,
  upsertStaffByTelegramId,
  type StaffMember,
  type StaffRole,
  type UpsertStaffInput,
} from './staff.ts';

export {
  PANEL_DEFAULT_ROWS,
  PANEL_MAX_ROWS,
  clampPanelLimit,
  clampPanelOffset,
  PANEL_HOLD_PROVIDER_STATUSES,
  PANEL_PENDING_ORDER_STATUSES,
  getClientDetailForPanel,
  getOrderDetailForPanel,
  listHoldsForPanel,
  listOrdersForPanel,
  listPendingOrdersForPanel,
  countPendingOrdersForPanel,
  listSupportRequestsForPanel,
  countUnansweredSupportRequests,
  listReferralPartnersForPanel,
  listPartnerReferralsForPanel,
  listReferralPayoutsForPanel,
  type PanelPartner,
  type PanelPartnerReferral,
  type PanelPayoutRequest,
  getSupportThreadForPanel,
  claimSupportConversation,
  type PanelSupportRequest,
  type PanelSupportThread,
  type PanelSupportMessage,
  type PanelPendingOrder,
  type PanelClientCard,
  type PanelClientDetail,
  type PanelClientOrder,
  type PanelClientRef,
  type PanelClientReferralLink,
  type PanelHoldClient,
  type PanelHoldRow,
  type PanelOrderCard,
  type PanelOrderDetail,
  type PanelOrderEvent,
  type PanelOrderListFilters,
  type PanelOrderListItem,
  type PanelOrderListPage,
  type PanelOrderPayment,
  type PanelOrderSort,
} from './panel.ts';

export {
  saveVccBalanceSnapshot,
  getVccBalanceSnapshot,
  acquireCardFundLock,
  sumLiveCardFundReservations,
  insertCardFundReservation,
  releaseCardFundReservation,
  deleteExpiredCardFundReservations,
  VCC_SNAPSHOT_PROVIDER,
  type VccBalanceSnapshot,
} from './vcc-balance.ts';

export {
  getFunnelUserState,
  setFunnelOptOut,
  hasActiveOperatorConversation,
  countFunnelSendsSince,
  getLastFunnelSendAt,
  claimFunnelSend,
  recordClientFeedback,
  findExpiredOrdersForSurvey,
  findFreshUsersWithoutOrders,
  findCompletedOrdersForRating,
  findRatedUsersForReferralNudge,
  type FunnelUserState,
  type FunnelWindow,
  type ExpiredOrderForSurvey,
  type CompletedOrderForRating,
} from './funnel.ts';
