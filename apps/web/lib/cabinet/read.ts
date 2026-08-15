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
  servicePaymentInstructions,
  type ServicePaymentInstructions,
} from '@oplati/types';

import { childLogger } from '../logger.ts';
import { phoneRequirementRub } from '../contacts/phone-gate.ts';
import { buyerFeePercentForOrder } from '../payments/gateway.ts';
import { withLiveBalance, type CardWithLive } from './live-balance.ts';
import {
  CARD_LIFETIME_DAYS,
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
  subscription_activated: 'Подписка оплачена на сайте сервиса',
  payment_issue_reported: 'Сообщение о проблеме с оплатой',
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
  };
}

/**
 * «Действует до» карты — РАНЬШАЯ из двух дат, потому что карта умирает от любой:
 *
 *  1. `exp_date` самой карты (MM/YY из PaySpace `getCardInfo`, L-10 аудита) —
 *     дальше её не примет платёжная сеть;
 *  2. дата выпуска + `CARD_LIFETIME_DAYS` (180 дней) — на этом сроке карту
 *     закрывает наш cron `recycle-cards`, а выборки кабинета перестают её
 *     показывать и отдавать по ней реквизиты (см. `findCardsByUserIdForCabinet`).
 *
 * Раньше приоритет был безусловно за `exp_date`, и витрина обещала срок
 * платёжной сети: у карты, выпущенной 25.06.2026 с `exp_date=06/30`, кабинет
 * показывал «30 июня 2030» при фактическом закрытии 22.12.2026 — разрыв в
 * 3,5 года (найдено владельцем 2026-07-30). Обещание денежное: текст рядом
 * сообщает, что после этой даты выпуск новой карты добавится к сумме заказа.
 *
 * Fallback (нет live-ответа / кривой формат) — наш срок: он единственный,
 * который мы можем гарантировать сами.
 */
export function cardValidUntil(createdAt: Date, liveExpDate?: string): string {
  const ourDeadlineMs = createdAt.getTime() + CARD_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
  const networkExpiry = liveExpDate ? parseExpDate(liveExpDate) : null;
  if (!networkExpiry) return new Date(ourDeadlineMs).toISOString();
  return new Date(Math.min(new Date(networkExpiry).getTime(), ourDeadlineMs)).toISOString();
}

/**
 * `MM/YY` → ISO конца месяца; мусор → null (fallback caller'а).
 * 20:59:59 UTC = 23:59:59 по Москве: UI рендерит через formatExpires
 * (Europe/Moscow), и полночь UTC показывалась бы как «02:59 1-го СЛЕДУЮЩЕГО
 * месяца» (находка ревью волны 2026-07-19).
 */
function parseExpDate(expDate: string): string | null {
  const m = /^(\d{2})\/(\d{2})$/.exec(expDate);
  if (!m) return null;
  const month = Number(m[1]);
  const year = 2000 + Number(m[2]);
  if (month < 1 || month > 12) return null;
  // День 0 следующего месяца = последний день указанного.
  return new Date(Date.UTC(year, month, 0, 20, 59, 59)).toISOString();
}

const log = childLogger('cabinet.read');

/**
 * Безопасный парс `services.payment_instructions`: битая запись → null
 * (клиент увидит generic-подсказку, сервис не прячем), но с warn в лог —
 * иначе испорченная запись молча жила бы generic-текстом бесконечно.
 */
function parseInstructions(raw: unknown): ServicePaymentInstructions | null {
  if (raw === null || raw === undefined) return null;
  const parsed = servicePaymentInstructions.safeParse(raw);
  if (!parsed.success) {
    log.warn({ event: 'cabinet.read.instructions_invalid' });
    return null;
  }
  return parsed.data;
}

/** Контекст карты для «Для оплаты: …» — из последнего заказа с этой картой. */
type CardPurpose = {
  purpose: string | null;
  purposeOrderId: string | null;
  instructions: ServicePaymentInstructions | null;
};

const EMPTY_PURPOSE: CardPurpose = { purpose: null, purposeOrderId: null, instructions: null };

function mapCard(card: CardWithLive, purpose: CardPurpose = EMPTY_PURPOSE): CardView {
  return {
    id: card.id,
    panMasked: card.panMasked,
    status: card.status,
    statusLabel: CARD_STATUS_LABELS[card.status],
    balanceUsdCents: card.balanceUsdCents,
    createdAt: card.createdAt.toISOString(),
    validUntil: cardValidUntil(card.createdAt, card.liveExpDate),
    ...purpose,
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
  return { label, at: event.createdAt.toISOString(), type: event.eventType };
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
  // Live-баланс основной карты (PaySpace) — параллельно с резолвом сервисов,
  // чтобы не удлинять критический путь снапшота; сбой → БД-снимок как был.
  const [services, cardsWithLiveBalance] = await Promise.all([
    getServicesByIds(db, serviceIds),
    withLiveBalance(db, cards),
  ]);
  const serviceNameById = new Map(services.map((s) => [s.id, s.name]));
  const serviceInstructionsById = new Map(
    services.map((s) => [s.id, parseInstructions(s.paymentInstructions)]),
  );

  const orderSummaries = orders.map((o) =>
    mapOrderSummary(o, o.serviceId ? serviceNameById.get(o.serviceId) ?? null : null),
  );

  // «Для оплаты: …» на карте — сервис самого свежего заказа этой карты.
  const purposeForCard = (cardId: string): CardPurpose => {
    const order = orders
      .filter((o) => o.cardId === cardId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!order) return EMPTY_PURPOSE;
    const name = order.serviceId ? serviceNameById.get(order.serviceId) ?? null : null;
    return {
      purpose: name ?? order.customServiceDescription ?? null,
      purposeOrderId: order.id,
      instructions: order.serviceId
        ? serviceInstructionsById.get(order.serviceId) ?? null
        : null,
    };
  };

  const purchased = orders.filter((o) => PURCHASED_STATUSES.includes(o.status));
  const totalSpentKopecks = purchased.reduce((sum, o) => sum + (o.amountRub ?? 0), 0);

  const profile: CabinetProfile = {
    displayName: profileRow?.displayName ?? null,
    phone: profileRow?.phone ?? null,
    phoneSource: profileRow?.phoneSource ?? null,
    email: profileRow?.email ?? null,
    telegramLinked: profileRow?.telegramLinked ?? true,
    memberSince: (profileRow?.createdAt ?? new Date()).toISOString(),
    ordersCount: purchased.length,
    totalSpentKopecks,
  };

  return {
    profile,
    orders: orderSummaries,
    cards: cardsWithLiveBalance.map((c) => mapCard(c, purposeForCard(c.id))),
    phoneRequiredFromRub: phoneRequirementRub(),
  };
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

  const service = order.serviceId ? await getServiceById(db, order.serviceId) : null;
  const serviceName = service?.name ?? null;
  const instructions = service ? parseInstructions(service.paymentInstructions) : null;

  const card = order.cardId ? cards.find((c) => c.id === order.cardId) ?? null : null;
  const cardPurpose: CardPurpose = {
    purpose: serviceName ?? order.customServiceDescription ?? null,
    purposeOrderId: order.id,
    instructions,
  };

  return {
    ...mapOrderSummary(order, serviceName),
    originalAmount: order.originalAmount,
    originalCurrency: order.originalCurrency,
    commissionPercent: order.commissionPercent,
    usdtRubRateKopecks: order.usdtRubRateKopecks,
    instructions,
    cardIssueFeeKopecks: order.cardIssueFeeKopecks,
    buyerFeePercent: buyerFeePercentForOrder(payments),
    paidAt: toIso(order.paidAt),
    fulfilledAt: toIso(order.fulfilledAt),
    events: events.map(mapEvent),
    payments: payments.map(mapPayment),
    card: card ? mapCard(card, cardPurpose) : null,
  };
}
