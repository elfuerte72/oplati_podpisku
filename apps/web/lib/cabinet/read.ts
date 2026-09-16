import 'server-only';

import {
  getDb,
  getOrderById,
  getOrdersByUserId,
  getOrderEventsByOrderId,
  getReferralBalanceUsdCents,
  getServiceById,
  getServicesByIds,
  getUserProfileById,
  findCardsByUserIdForCabinet,
  findPaymentsByOrderId,
  findPromoRedemptionByOrderId,
  findPromoRedemptionsByOrderIds,
  findRedemptionByOrderId,
  findRedemptionsByOrderIds,
  BONUS_RELEASED_EVENT,
  BONUS_RESERVED_EVENT,
  BONUS_SPENT_EVENT,
  PAYMENT_BLOCKED_CAPACITY_EVENT,
  PAYMENT_REMINDER_FAILED_EVENT,
  PAYMENT_REMINDER_SENT_EVENT,
  PAYMENT_REVIEW_CLIENT_NOTIFIED_EVENT,
  PROMO_RELEASED_EVENT,
  PROMO_RESERVED_EVENT,
  PROMO_SPENT_EVENT,
  type Card,
  type OrderEventRow,
  type OrderRow,
  type PaymentRow,
  type PromoRedemptionRow,
  type RedemptionRow,
} from '@oplati/db';
import {
  servicePaymentInstructions,
  type ServicePaymentInstructions,
} from '@oplati/types';

import { childLogger } from '../logger.ts';
import { phoneRequirementRub } from '../contacts/phone-gate.ts';
import { buyerFeePercentForOrder } from '../payments/gateway.ts';
import { bonusValueKopecks } from '../referral/spend-math.ts';
import { isPromoEnabled } from '../promo/apply.ts';
import { isBonusSpendEnabled, loadBonusSpendStateSafe } from '../referral/spend.ts';
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
  type OrderBonusView,
  type OrderDetail,
  type OrderEventView,
  type OrderPromoView,
  type OrderRedemptionView,
  type OrderSummary,
  type PaymentView,
} from './types.ts';

/**
 * СЛУЖЕБНЫЕ события: они есть в журнале, но клиенту в таймлайне не место.
 *
 * `order_events` — общая поверхность трёх потребителей: выручка, панель и
 * Mini App клиента. Про первых двух помнят все, про третьего забывают: любой
 * новый тип события без ярлыка доезжает клиенту строкой «Событие» с временем и
 * без смысла — и делает это на самом тревожном экране продукта (деньги
 * списаны, банк держит перевод). Поэтому фильтр — денилист, а не «допишите
 * ярлык, когда вспомните»: неизвестное клиенту НЕ показывается.
 *
 * Здесь ровно то, что описывает НАШИ действия вокруг клиента, а не судьбу его
 * заказа: отметка «мы предупредили о холде» и «напоминание о продлении
 * отправлено». Клиент про оба узнаёт из самого сообщения в Telegram.
 */
const INTERNAL_EVENT_TYPES = new Set<string>([
  // ⚠️ Константами, а не литералами: имена событий пишет `@oplati/db`, и
  // литерал здесь был бы зеркалом без автосверки (инвариант 10). Цена
  // расхождения — наше служебное действие в таймлайне КЛИЕНТА.
  PAYMENT_REVIEW_CLIENT_NOTIFIED_EVENT,
  PAYMENT_REMINDER_SENT_EVENT,
  // Сорванная доставка напоминания — тем более служебная: клиенту незачем
  // знать, что мы не смогли до него достучаться.
  PAYMENT_REMINDER_FAILED_EVENT,
  // «Мы не выставили счёт, потому что выпускать карту не на что» — запись про
  // НАШУ казну (трек vcc-preflight). Клиент свой текст уже получил в ответ на
  // кнопку; строка в истории заказа добавила бы к ней только тревогу.
  PAYMENT_BLOCKED_CAPACITY_EVENT,
  // Учёт баллов — наш, а не судьба заказа клиента: он видит скидку прямо в
  // сумме на экране, и «bonus_reserved» в истории добавило бы только вопросы.
  BONUS_RESERVED_EVENT,
  BONUS_SPENT_EVENT,
  BONUS_RELEASED_EVENT,
  // Учёт промокода — по той же причине наш: скидку клиент видит в сумме на
  // экране заказа, а «promo_reserved» в истории только добавило бы вопросов.
  PROMO_RESERVED_EVENT,
  PROMO_SPENT_EVENT,
  PROMO_RELEASED_EVENT,
  'renewal_reminder_sent',
]);

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

/** Живое списание (не возвращённое) в форму витрины; `null` — показывать нечего. */
function mapRedemption(row: RedemptionRow | null | undefined): OrderRedemptionView | null {
  if (!row || row.status === 'released') return null;
  return {
    discountKopecks: row.discountKopecks,
    spendUsdCents: row.amountUsdCents,
    status: row.status,
  };
}

/** Живая скидка по промокоду в форму витрины; `null` — показывать нечего. */
function mapPromoRedemption(row: PromoRedemptionRow | null | undefined): OrderPromoView | null {
  if (!row || row.status === 'released') return null;
  return { discountKopecks: row.discountKopecks, status: row.status };
}

function mapOrderSummary(
  order: OrderRow,
  serviceName: string | null,
  bonus: OrderRedemptionView | null = null,
  promo: OrderPromoView | null = null,
): OrderSummary {
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
    bonus,
    promo,
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

/**
 * Служебное ли это событие. Отдельной функцией, чтобы денилист проверялся
 * ПРЯМО: через `isClientVisibleOrderEvent` он не проверяется вовсе — событие
 * без ярлыка и так скрыто вторым эшелоном, и тест не заметил бы удаления
 * строки из списка (находка ревью).
 */
export function isInternalOrderEvent(eventType: string): boolean {
  return INTERNAL_EVENT_TYPES.has(eventType);
}

/** Показываем ли событие клиенту (см. `INTERNAL_EVENT_TYPES`). */
export function isClientVisibleOrderEvent(event: {
  eventType: string;
  toStatus: string | null;
}): boolean {
  if (isInternalOrderEvent(event.eventType)) return false;
  // Событие без ярлыка И без смены статуса подписать нечем — «Событие» в
  // истории заказа не значит ничего и только пугает.
  return Boolean(EVENT_LABELS[event.eventType] ?? event.toStatus);
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

  // Списания пачкой (трек referral-balance-spend): строка «−286 ₽ баллами»
  // нужна в блоке «Ждут оплаты», а запрос на заказ превратил бы снапшот в
  // N+1. Выключенная фича базу не трогает вовсе, но уже занятые баллы
  // продолжают показываться — гасить фичу не значит скрыть чужие деньги.
  const orderIds = orders.map((o) => o.id);
  const [redemptions, promoRedemptions] = await Promise.all([
    findRedemptionsByOrderIds(db, orderIds),
    // Скидки по промокодам — той же пачкой и по той же причине (трек promo-codes).
    findPromoRedemptionsByOrderIds(db, orderIds),
  ]);

  const orderSummaries = orders.map((o) =>
    mapOrderSummary(
      o,
      o.serviceId ? serviceNameById.get(o.serviceId) ?? null : null,
      mapRedemption(redemptions.get(o.id)),
      mapPromoRedemption(promoRedemptions.get(o.id)),
    ),
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

  // Баланс баллов в профиле — только когда фича включена: иначе цифра, которую
  // некуда потратить, читается как обещание.
  //
  // Never-throw: снапшот кабинета — главный экран продукта, и падать целиком
  // из-за справочной цифры он не должен.
  let bonusBalanceUsdCents: number | null = null;
  if (isBonusSpendEnabled()) {
    try {
      bonusBalanceUsdCents = await getReferralBalanceUsdCents(db, userId);
    } catch (err) {
      log.warn({ event: 'cabinet.read.bonus_balance_failed', err });
    }
  }

  const profile: CabinetProfile = {
    displayName: profileRow?.displayName ?? null,
    phone: profileRow?.phone ?? null,
    phoneSource: profileRow?.phoneSource ?? null,
    email: profileRow?.email ?? null,
    telegramLinked: profileRow?.telegramLinked ?? true,
    memberSince: (profileRow?.createdAt ?? new Date()).toISOString(),
    ordersCount: purchased.length,
    totalSpentKopecks,
    bonusBalanceUsdCents: bonusBalanceUsdCents !== null && bonusBalanceUsdCents > 0
      ? bonusBalanceUsdCents
      : null,
  };

  return {
    profile,
    orders: orderSummaries,
    cards: cardsWithLiveBalance.map((c) => mapCard(c, purposeForCard(c.id))),
    phoneRequiredFromRub: phoneRequirementRub(),
  };
}

/**
 * Что показать в блоке баллов на экране заказа. `null` — блока нет.
 *
 * Три состояния различает уже UI, и все три выводятся отсюда (§8 спеки):
 * «есть что списать» (`offer !== null`), «баланс больше потолка»
 * (`balanceKopecks > capKopecks`) и «баллы копятся» (`offer === null` при
 * положительном балансе). Числа считает одна и та же математика, что и
 * `payments/create`, — иначе экран обещал бы одну скидку, а счёт уходил бы на
 * другую сумму.
 *
 * ⚠️ Заказ с уже выставленным счётом предложением ВОСПОЛЬЗОВАТЬСЯ не может:
 * переставить сумму инвойса мы не умеем (API правки нет ни у Freekassa, ни у
 * L&P), а второй счёт на заказ запрещён частичным UNIQUE. Блок для него всё
 * равно считается — но только ради подсказки «отмени заказ и оформи заново»:
 * без неё она показывалась бы КАЖДОМУ клиенту со счётом, включая тех, у кого
 * баллов нет вовсе. Скрывать переключатель в этом состоянии — дело экрана.
 */
export async function buildOrderBonusView(
  order: OrderRow,
  /**
   * Живая скидка по промокоду на этом заказе (трек promo-codes). Порядок
   * «промокод первый, баллы вторые»: потолок баллов считается от ОСТАВШЕЙСЯ
   * маржи, иначе экран пообещал бы списание из маржи, которую промокод уже съел.
   */
  promoDiscountKopecks = 0,
): Promise<OrderBonusView | null> {
  if (!isPayableStatus(order.status)) return null;
  const state = await loadBonusSpendStateSafe(order, promoDiscountKopecks);
  if (state === null) return null;
  return {
    balanceUsdCents: state.balanceUsdCents,
    balanceKopecks: bonusValueKopecks(state.balanceUsdCents, order.usdtRubRateKopecks ?? 0),
    capKopecks: state.capKopecks,
    offer: state.offer,
    minSpendUsdCents: state.minSpendUsdCents,
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

  const [events, payments, cards, redemption, promoRedemption] = await Promise.all([
    getOrderEventsByOrderId(db, orderId),
    findPaymentsByOrderId(db, orderId),
    findCardsByUserIdForCabinet(db, userId),
    findRedemptionByOrderId(db, orderId),
    findPromoRedemptionByOrderId(db, orderId),
  ]);
  const promoView = mapPromoRedemption(promoRedemption);

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
    ...mapOrderSummary(order, serviceName, mapRedemption(redemption), promoView),
    bonusOffer: await buildOrderBonusView(order, promoView?.discountKopecks ?? 0),
    promoInputEnabled: isPromoEnabled(),
    originalAmount: order.originalAmount,
    originalCurrency: order.originalCurrency,
    commissionPercent: order.commissionPercent,
    usdtRubRateKopecks: order.usdtRubRateKopecks,
    instructions,
    cardIssueFeeKopecks: order.cardIssueFeeKopecks,
    buyerFeePercent: buyerFeePercentForOrder(payments),
    paidAt: toIso(order.paidAt),
    fulfilledAt: toIso(order.fulfilledAt),
    events: events.filter(isClientVisibleOrderEvent).map(mapEvent),
    payments: payments.map(mapPayment),
    card: card ? mapCard(card, cardPurpose) : null,
  };
}
