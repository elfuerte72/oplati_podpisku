import type {
  CardStatus,
  OrderStatus,
  PaymentStatus,
  ServicePaymentInstructions,
} from '@oplati/types';

/**
 * View-типы личного кабинета (Telegram Mini App). Это контракт между
 * `/api/cabinet` и клиентом `components/cabinet/*`.
 *
 * Конвенции:
 *  - деньги — целые: `amountKopecks` (RUB-копейки), `balanceUsdCents` (USD-центы);
 *  - даты — ISO-строки (клиент форматирует через `components/comic/format`);
 *  - карты — ТОЛЬКО `panMasked` (инвариант безопасности: полный PAN/CVC уходит
 *    клиенту единственным путём — сообщением в Telegram, не через этот API).
 */

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  draft: 'Черновик',
  clarifying: 'Уточняем',
  kyc_required: 'Нужны документы',
  ready_for_payment: 'Готов к оплате',
  pending_payment: 'Ждёт оплаты',
  paid: 'Оплачен',
  in_fulfillment: 'Выполняется',
  completed: 'Готово',
  failed: 'Ошибка',
  cancelled: 'Отменён',
  expired: 'Истёк срок',
  refund_requested: 'Запрошен возврат',
  refunded: 'Возвращён',
};

export const CARD_STATUS_LABELS: Record<CardStatus, string> = {
  active: 'Активна',
  idle: 'В простое',
  recycled: 'В переработке',
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: 'Ожидает оплаты',
  succeeded: 'Оплачен',
  failed: 'Ошибка',
  refunded: 'Возврат',
};

/** Статусы, из которых заказ ещё можно оплатить из кабинета. */
export const PAYABLE_STATUSES: readonly OrderStatus[] = ['ready_for_payment', 'pending_payment'];

export function isPayableStatus(status: OrderStatus): boolean {
  return PAYABLE_STATUSES.includes(status);
}

/** Статусы, которые считаем «состоявшейся покупкой» (для счётчиков профиля). */
export const PURCHASED_STATUSES: readonly OrderStatus[] = [
  'paid',
  'in_fulfillment',
  'completed',
];

export type CabinetProfile = {
  displayName: string | null;
  phone: string | null;
  email: string | null;
  telegramLinked: boolean;
  memberSince: string;
  ordersCount: number;
  totalSpentKopecks: number;
};

export type OrderSummary = {
  orderId: string;
  shortId: string;
  status: OrderStatus;
  statusLabel: string;
  service: string;
  amountKopecks: number | null;
  createdAt: string;
  expiresAt: string | null;
  /** Можно ли оплатить заказ из кабинета (кнопка «Оплатить»). */
  payable: boolean;
};

/**
 * Срок жизни карты в днях (ТЗ §2: «Карта действует 180 дней») — витринное
 * «Действует до» на экране карты.
 *
 * Реэкспорт из `@oplati/types`: то же число используют SQL-условия репозитория
 * карт (порог release в cron `recycle-cards` и отсечка просроченных в выборках
 * кабинета). Держать здесь собственный литерал нельзя — разъехавшись, кабинет
 * обещал бы клиенту один срок, а cron закрывал карту в другой.
 */
export { CARD_LIFETIME_DAYS } from '@oplati/types';

export type CardView = {
  /** id карты в нашей БД — для запроса реквизитов (`card-details`); не секрет. */
  id: string;
  panMasked: string;
  status: CardStatus;
  statusLabel: string;
  balanceUsdCents: number;
  createdAt: string;
  /** «Действует до» — createdAt + CARD_LIFETIME_DAYS (ISO). */
  validUntil: string;
  /** Название сервиса последнего заказа этой карты («Для оплаты: …»); null — нет заказа. */
  purpose: string | null;
  /** id последнего заказа карты — для «Не проходит оплата?» с контекстом. */
  purposeOrderId: string | null;
  /** Правила оплаты сервиса последнего заказа (кнопки «Перейти на сайт» / «Инструкция»). */
  instructions: ServicePaymentInstructions | null;
};

export type PaymentView = {
  amountKopecks: number;
  status: PaymentStatus;
  statusLabel: string;
  invoiceNumber: string | null;
  createdAt: string;
};

export type OrderEventView = {
  label: string;
  at: string;
  /** Сырой event_type — клиент выводит из него пост-выпускной статус заказа. */
  type: string;
};

/**
 * События «жизни после выпуска карты» (ТЗ §6). Пишутся в append-only
 * `order_events` (статус-машину заказа не трогаем — completed остаётся
 * терминальным): клиент отметил подписку оплаченной / сообщил о проблеме.
 */
export const SUBSCRIPTION_ACTIVATED_EVENT = 'subscription_activated';
export const PAYMENT_ISSUE_EVENT = 'payment_issue_reported';

export type OrderDetail = OrderSummary & {
  originalAmount: number | null;
  originalCurrency: string | null;
  commissionPercent: number | null;
  /** Зафиксированный курс USDT→RUB × 10000 (как в orders) — для «Как рассчитана сумма». */
  usdtRubRateKopecks: number | null;
  /** Правила оплаты сервиса (VPN/валюта/billing/ссылка) — блок после выпуска карты. */
  instructions: ServicePaymentInstructions | null;
  /**
   * Снимок разовой надбавки за выпуск карты (RUB-копейки), уже включённой в
   * `amountKopecks`. `null` — заказ до фичи; `0` — повторная оплата (карта уже
   * есть); `>0` — первая оплата с оплаченным issue-fee. Экран заказа рисует по
   * нему разбивку «Подписка / Выпуск карты / Итого».
   */
  cardIssueFeeKopecks: number | null;
  paidAt: string | null;
  fulfilledAt: string | null;
  events: OrderEventView[];
  payments: PaymentView[];
  card: CardView | null;
};

export type CabinetSnapshot = {
  profile: CabinetProfile;
  orders: OrderSummary[];
  cards: CardView[];
};
