import 'server-only';

import {
  getDb,
  getOrderById,
  getOrdersByUserId,
  getOrderEventsByOrderId,
  getServiceById,
  getServicesByIds,
  getUserProfileById,
  findCardsByUserIdForCabinet,
  findPaymentsByOrderId,
  type Card,
  type OrderEventRow,
  type OrderRow,
  type PaymentRow,
} from '@oplati/db';

import {
  CARD_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  PURCHASED_STATUSES,
  isPayableStatus,
  type CabinetProfile,
  type CabinetSnapshot,
  type CardView,
  type OrderDetail,
  type OrderEventView,
  type OrderSummary,
  type PaymentView,
} from './types.ts';

/** Человекочитаемые ярлыки событий `order_events` для таймлайна кабинета. */
const EVENT_LABELS: Record<string, string> = {
  order_created: 'Заказ создан',
  status_changed: 'Статус изменён',
  payment_invoice_created: 'Счёт выставлен',
  payment_succeeded: 'Оплата прошла',
  card_issued: 'Карта выпущена',
  handoff_requested: 'Запрошен оператор',
  user_cancelled: 'Отменён клиентом',
};

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapOrderSummary(order: OrderRow, serviceName: string | null): OrderSummary {
  return {
    orderId: order.id,
    shortId: order.shortId,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status],
    service: serviceName ?? order.customServiceDescription ?? 'Заказ',
    amountKopecks: order.amountRub,
    createdAt: order.createdAt.toISOString(),
    expiresAt: toIso(order.expiresAt),
    payable: isPayableStatus(order.status),
    repeatable: order.serviceId !== null,
  };
}

function mapCard(card: Card): CardView {
  return {
    panMasked: card.panMasked,
    status: card.status,
    statusLabel: CARD_STATUS_LABELS[card.status],
    balanceUsdCents: card.balanceUsdCents,
    createdAt: card.createdAt.toISOString(),
  };
}

function mapPayment(payment: PaymentRow): PaymentView {
  return {
    amountKopecks: payment.amountRub,
    status: payment.status,
    statusLabel: PAYMENT_STATUS_LABELS[payment.status],
    invoiceNumber: payment.providerInvoiceNumber ?? null,
    createdAt: payment.createdAt.toISOString(),
  };
}

function mapEvent(event: OrderEventRow): OrderEventView {
  const label =
    EVENT_LABELS[event.eventType] ??
    (event.toStatus ? ORDER_STATUS_LABELS[event.toStatus] : 'Событие');
  return { label, at: event.createdAt.toISOString() };
}

/**
 * Полный снимок кабинета: профиль + список заказов + карты. Названия сервисов
 * резолвятся одним запросом (`getServicesByIds`), счётчики профиля считаются из
 * уже загруженных заказов (без отдельного агрегирующего запроса).
 */
export async function buildSnapshot(userId: string): Promise<CabinetSnapshot> {
  const db = getDb();

  const [orders, cards, profileRow] = await Promise.all([
    getOrdersByUserId(db, userId),
    findCardsByUserIdForCabinet(db, userId),
    getUserProfileById(db, userId),
  ]);

  const serviceIds = [...new Set(orders.map((o) => o.serviceId).filter((id): id is string => id !== null))];
  const services = await getServicesByIds(db, serviceIds);
  const serviceNameById = new Map(services.map((s) => [s.id, s.name]));

  const orderSummaries = orders.map((o) =>
    mapOrderSummary(o, o.serviceId ? serviceNameById.get(o.serviceId) ?? null : null),
  );

  const purchased = orders.filter((o) => PURCHASED_STATUSES.includes(o.status));
  const totalSpentKopecks = purchased.reduce((sum, o) => sum + (o.amountRub ?? 0), 0);

  const profile: CabinetProfile = {
    displayName: profileRow?.displayName ?? null,
    phone: profileRow?.phone ?? null,
    email: profileRow?.email ?? null,
    telegramLinked: profileRow?.telegramLinked ?? true,
    memberSince: (profileRow?.createdAt ?? new Date()).toISOString(),
    ordersCount: purchased.length,
    totalSpentKopecks,
  };

  return { profile, orders: orderSummaries, cards: cards.map(mapCard) };
}

/**
 * Детали одного заказа: сводка + таймлайн событий + платежи + карта.
 * Ownership: возвращает `null`, если заказ не найден ИЛИ принадлежит другому
 * пользователю (не раскрываем существование чужого заказа).
 */
export async function buildOrderDetail(userId: string, orderId: string): Promise<OrderDetail | null> {
  const db = getDb();
  const order = await getOrderById(db, orderId);
  if (!order || order.userId !== userId) return null;

  const [events, payments, cards] = await Promise.all([
    getOrderEventsByOrderId(db, orderId),
    findPaymentsByOrderId(db, orderId),
    findCardsByUserIdForCabinet(db, userId),
  ]);

  const serviceName = order.serviceId
    ? (await getServiceById(db, order.serviceId))?.name ?? null
    : null;

  const card = order.cardId ? cards.find((c) => c.id === order.cardId) ?? null : null;

  return {
    ...mapOrderSummary(order, serviceName),
    originalAmount: order.originalAmount,
    originalCurrency: order.originalCurrency,
    commissionPercent: order.commissionPercent,
    paidAt: toIso(order.paidAt),
    fulfilledAt: toIso(order.fulfilledAt),
    events: events.map(mapEvent),
    payments: payments.map(mapPayment),
    card: card ? mapCard(card) : null,
  };
}
