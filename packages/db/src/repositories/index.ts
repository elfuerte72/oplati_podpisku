export {
  getOrCreateUserByTelegramId,
  getOrCreateUserByWebSessionId,
  getUserTelegramId,
  findUserIdByWebSessionId,
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
  loadRecentMessages,
  type AppendMessageInput,
  type AppendMessageResult,
  type MessageHistoryItem,
} from './messages.ts';

export { noopLogger, type RepoLogger } from './logger.ts';

export { pingDb } from './health.ts';

export {
  createCard,
  findActiveByUserId,
  findRecyclableCard,
  markIdle,
  markRecycled,
  markActive,
  updateBalance,
  recycleAgedCards,
  type Card,
  type CreateCardInput,
} from './cards.ts';

export {
  createDraftOrder,
  getOrderById,
  getOrderByShortId,
  transitionOrder,
  setOrderCardId,
  findExpiredPendingOrders,
  findOrdersForRenewalReminder,
  hasRecentOrderEvent,
  type OrderRow,
  type CreateDraftOrderInput,
  type TransitionOrderInput,
} from './orders.ts';

export {
  upsertPaymentByProviderRef,
  markPaymentSucceeded,
  markPaymentStatus,
  findPendingPaymentsForPoll,
  findPaymentByProviderRef,
  type PaymentRow,
  type UpsertPaymentByProviderRefInput,
  type UpsertResult,
  type MarkPaymentSucceededInput,
} from './payments.ts';

export {
  searchActiveServices,
  getServiceById,
  getServiceBySlug,
  type ServiceRow,
  type CatalogSearchItem,
} from './services.ts';
