import { and, asc, countDistinct, desc, eq, inArray, ilike, max, or, sql } from 'drizzle-orm';

import {
  DEFAULT_REFERRAL_RATE_L1_BPS,
  FREEKASSA_ORDER_STATUS,
  SUPPORT_DELIVERED_META_KEY,
  SUPPORT_REQUEST_META_KEY,
  type CardStatus,
  type OrderStatus,
  type PaymentStatus,
  type PayoutStatus,
} from '@oplati/types';

import {
  cards,
  conversations,
  messages,
  orderEvents,
  orders,
  payments,
  services,
  staff,
  users,
} from '../schema.ts';
import type { DB } from '../index.ts';
import { balanceExpr } from './referral-accruals.ts';
import { PURCHASED_STATUSES_SQL } from './order-status-sql.ts';
import { transitionConversationMode } from './support.ts';
import {
  PAYMENT_REMINDER_FAILED_EVENT,
  PAYMENT_REMINDER_SENT_EVENT,
  PAYMENT_REVIEW_CLIENT_NOTIFIED_EVENT,
} from './orders.ts';

/**
 * Выборки админ-панели: список заказов и карточка заказа.
 *
 * Живут в репозитории, а не в панели, по двум причинам сразу: в `apps/web` не
 * должно быть своих SQL-запросов (тикет 03), и потолок выборки обязан стоять
 * ЗДЕСЬ — панель делит процесс с вебхуками Freekassa и Telegram, и один экран с
 * забытым фильтром не должен тянуть всю таблицу в тот же event loop, что
 * принимает деньги.
 *
 * ⚠️ Полные `pan`/`cvc` наружу не отдаются никогда — только `pan_masked`.
 * Санкционированных каналов выдачи ровно два (сообщение в Telegram при выпуске
 * и разовый показ в кабинете), и панель третьим не становится. В `cards` полного
 * PAN и нет: он не сохраняется вовсе.
 */

/** Потолок строк на выборку. Экран панели читают глазами, не выгружают. */
export const PANEL_MAX_ROWS = 100;
export const PANEL_DEFAULT_ROWS = 50;

/**
 * Приведение запрошенного размера страницы к допустимому.
 *
 * Вынесено и экспортировано намеренно: интеграционный тест потолка на
 * маленькой базе ничего не доказывает (строк меньше потолка — утверждение
 * выполняется само собой, и поднятие потолка в сто раз тест не роняет), а вот
 * эта функция проверяется прямо.
 *
 * `NaN` отдельным случаем: `Math.min(Math.max(NaN, 1), 100)` — это `NaN`,
 * который уезжает в `LIMIT` и роняет запрос.
 */
export function clampPanelLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return PANEL_DEFAULT_ROWS;
  return Math.min(Math.max(Math.floor(requested), 1), PANEL_MAX_ROWS);
}

/** То же для смещения: отрицательное и нечисловое — ноль. */
export function clampPanelOffset(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return 0;
  return Math.max(Math.floor(requested), 0);
}

/**
 * Потолок длины поискового запроса. Без него строка любой длины гоняет четыре
 * ILIKE с ведущим `%` в том же процессе, что принимает вебхуки.
 */
const MAX_QUERY_LENGTH = 100;

/**
 * Экранирование спецсимволов LIKE. Без него оператор, ищущий `100%` или
 * `ivan_petrov@…`, получает подстановочный знак вместо литерала и недоумевает,
 * почему выдача не та. Инъекции здесь нет (параметр связан), это корректность.
 * Обратный слэш — экранирующий символ LIKE по умолчанию в Postgres.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export type PanelOrderListFilters = {
  statuses?: readonly OrderStatus[];
  /** Номер заказа, telegram_id, email или имя клиента. */
  query?: string;
  limit?: number;
  offset?: number;
  /** Сортировка. По умолчанию — свежие первыми. */
  sort?: PanelOrderSort;
};

/** Порядок списка. Живёт в адресе экрана — ссылку можно переслать коллеге. */
export type PanelOrderSort = 'newest' | 'oldest' | 'amount_desc' | 'amount_asc';

export type PanelClientRef = {
  id: string;
  displayName: string | null;
  telegramId: string | null;
  email: string | null;
};

export type PanelOrderListItem = {
  id: string;
  shortId: string;
  status: OrderStatus;
  /** Копейки — как и везде в проекте (инвариант 3). */
  amountRubKopecks: number | null;
  createdAt: Date;
  expiresAt: Date | null;
  /** Каталожное имя либо свободное описание — строка таблицы не бывает пустой. */
  serviceName: string | null;
  client: PanelClientRef;
  /** Кто ведёт заказ. */
  assignedOperatorName: string | null;
};

/**
 * Возраст заказа НЕ считается в SQL: панель показывает время в часовом поясе
 * браузера, а `now()` базы к этому отношения не имеет. Отдаём `createdAt`.
 */
export type PanelOrderListPage = {
  items: PanelOrderListItem[];
  /**
   * За потолком остались ещё строки. Экран обязан сказать об этом вслух:
   * молчаливое усечение читается как «это всё, что есть».
   */
  hasMore: boolean;
};

export async function listOrdersForPanel(
  db: DB,
  filters: PanelOrderListFilters = {},
): Promise<PanelOrderListPage> {
  const limit = clampPanelLimit(filters.limit);
  const offset = clampPanelOffset(filters.offset);

  const conditions = [];
  if (filters.statuses && filters.statuses.length > 0) {
    conditions.push(inArray(orders.status, [...filters.statuses]));
  }

  const query = filters.query?.trim().slice(0, MAX_QUERY_LENGTH);
  if (query) {
    const like = `%${escapeLikePattern(query)}%`;
    conditions.push(
      or(
        ilike(orders.shortId, like),
        ilike(users.telegramId, like),
        ilike(users.email, like),
        ilike(users.displayName, like),
      ),
    );
  }

  const rows = await db
    .select({
      id: orders.id,
      shortId: orders.shortId,
      status: orders.status,
      amountRub: orders.amountRub,
      createdAt: orders.createdAt,
      expiresAt: orders.expiresAt,
      customServiceDescription: orders.customServiceDescription,
      serviceName: services.name,
      clientId: users.id,
      clientDisplayName: users.displayName,
      clientTelegramId: users.telegramId,
      clientEmail: users.email,
      operatorName: staff.displayName,
    })
    .from(orders)
    .innerJoin(users, eq(orders.userId, users.id))
    .leftJoin(services, eq(orders.serviceId, services.id))
    .leftJoin(staff, eq(orders.assignedOperatorId, staff.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    // Вторым ключом — id: без тай-брейкера строки с одинаковым `created_at`
    // (пачка заказов в одну миллисекунду) на границе страниц дублируются или
    // пропадают.
    .orderBy(...orderByFor(filters.sort ?? 'newest'))
    // На одну больше, чем покажем: так «есть ли ещё» — факт, а не догадка
    // «пришло ровно столько, сколько просили».
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => ({
    id: row.id,
    shortId: row.shortId,
    status: row.status,
    amountRubKopecks: row.amountRub,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    serviceName: row.serviceName ?? row.customServiceDescription,
    client: {
      id: row.clientId,
      displayName: row.clientDisplayName,
      telegramId: row.clientTelegramId,
      email: row.clientEmail,
    },
    assignedOperatorName: row.operatorName,
  }));

  return { items, hasMore };
}

function orderByFor(sort: PanelOrderSort) {
  switch (sort) {
    case 'oldest':
      return [asc(orders.createdAt), asc(orders.id)];
    case 'amount_desc':
      return [desc(orders.amountRub), desc(orders.id)];
    case 'amount_asc':
      return [asc(orders.amountRub), asc(orders.id)];
    case 'newest':
    default:
      return [desc(orders.createdAt), desc(orders.id)];
  }
}

export type PanelOrderPayment = {
  id: string;
  provider: string;
  providerRef: string;
  providerInvoiceNumber: string | null;
  amountRubKopecks: number;
  /** Enum, а не `string`: экран обязан подписать КАЖДОЕ значение (см. format.ts). */
  status: PaymentStatus;
  /** Числовой код провайдера из последнего опроса (7 = холд антифрода). */
  lastProviderStatus: number | null;
  lastProviderStatusAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
};

export type PanelOrderEvent = {
  id: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorType: string | null;
  actorId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
};

/** Карта — ТОЛЬКО маскированная (см. заголовок модуля). */
export type PanelOrderCard = {
  id: string;
  panMasked: string;
  status: CardStatus;
  balanceUsdCents: number;
  createdAt: Date;
};

export type PanelOrderDetail = {
  /**
   * Есть ли по заказу УСПЕШНЫЙ платёж. Отдельным признаком, а не «догадайся по
   * статусу»: `failed` бывает и там, где денег не было вовсе (провайдер отверг
   * счёт) или пришла только часть (недоплата терминальна). Ручная выдача таких
   * заказов означала бы запись в выручку денег, которых нет.
   */
  hasSucceededPayment: boolean;
  order: {
    id: string;
    shortId: string;
    status: OrderStatus;
    amountRubKopecks: number | null;
    /** Снимок надбавки за выпуск карты — уже включён в сумму. */
    cardIssueFeeKopecks: number | null;
    commissionPercent: number | null;
    originalAmount: number | null;
    originalCurrency: string | null;
    usdtRubRateKopecks: number | null;
    createdAt: Date;
    expiresAt: Date | null;
    paidAt: Date | null;
    fulfilledAt: Date | null;
  };
  client: PanelClientRef;
  serviceName: string | null;
  assignedOperatorName: string | null;
  events: PanelOrderEvent[];
  payments: PanelOrderPayment[];
  card: PanelOrderCard | null;
};

export async function getOrderDetailForPanel(
  db: DB,
  shortId: string,
): Promise<PanelOrderDetail | null> {
  const headRows = await db
    .select({
      order: orders,
      clientId: users.id,
      clientDisplayName: users.displayName,
      clientTelegramId: users.telegramId,
      clientEmail: users.email,
      serviceName: services.name,
      operatorName: staff.displayName,
    })
    .from(orders)
    .innerJoin(users, eq(orders.userId, users.id))
    .leftJoin(services, eq(orders.serviceId, services.id))
    .leftJoin(staff, eq(orders.assignedOperatorId, staff.id))
    // Сравнение по КОЛОНКЕ как есть, а не `upper(short_id) = upper($1)`:
    // функциональное выражение слева не даёт использовать уникальный индекс
    // `orders_short_id_unique`, и каждое открытие карточки (плюс автообновление
    // раз в 25 с) превращалось бы в seq scan всей таблицы. Номер заказа
    // генерится только из `0-9A-Z` (`SHORT_ID_ALPHABET`), поэтому достаточно
    // привести к верхнему регистру ВВОД — регистр набранного руками номера
    // по-прежнему не важен.
    .where(eq(orders.shortId, shortId.trim().toUpperCase()))
    .limit(1);

  const head = headRows[0];
  if (!head) return null;

  const [eventRows, paymentRows, cardRows] = await Promise.all([
    // Берём СВЕЖИЕ и разворачиваем в памяти. `ASC LIMIT 100` у заказа с сотней
    // событий показал бы самые старые и молча отрезал последние — ровно те,
    // ради которых карточку и открывают.
    db
      .select({
        id: orderEvents.id,
        eventType: orderEvents.eventType,
        fromStatus: orderEvents.fromStatus,
        toStatus: orderEvents.toStatus,
        actorType: orderEvents.actorType,
        actorId: orderEvents.actorId,
        payload: orderEvents.payload,
        createdAt: orderEvents.createdAt,
      })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, head.order.id))
      .orderBy(desc(orderEvents.createdAt), desc(orderEvents.id))
      .limit(PANEL_MAX_ROWS),
    // Колонки перечислены явно: `payments.raw_payload` — сырое тело ответа
    // провайдера (контакты плательщика антифрод-трека), и тянуть его в процесс
    // панели незачем.
    db
      .select({
        id: payments.id,
        provider: payments.provider,
        providerRef: payments.providerRef,
        providerInvoiceNumber: payments.providerInvoiceNumber,
        amountRub: payments.amountRub,
        status: payments.status,
        lastProviderStatus: payments.lastProviderStatus,
        lastProviderStatusAt: payments.lastProviderStatusAt,
        createdAt: payments.createdAt,
        completedAt: payments.completedAt,
        expiresAt: payments.expiresAt,
      })
      .from(payments)
      .where(eq(payments.orderId, head.order.id))
      .orderBy(desc(payments.createdAt))
      .limit(PANEL_MAX_ROWS),
    head.order.cardId
      ? db.select().from(cards).where(eq(cards.id, head.order.cardId)).limit(1)
      : Promise.resolve([]),
  ]);

  const card = cardRows[0];

  return {
    hasSucceededPayment: paymentRows.some((p) => p.status === 'succeeded'),
    order: {
      id: head.order.id,
      shortId: head.order.shortId,
      status: head.order.status,
      amountRubKopecks: head.order.amountRub,
      cardIssueFeeKopecks: head.order.cardIssueFeeKopecks,
      commissionPercent: head.order.commissionPercent,
      originalAmount: head.order.originalAmount,
      originalCurrency: head.order.originalCurrency,
      usdtRubRateKopecks: head.order.usdtRubRateKopecks,
      createdAt: head.order.createdAt,
      expiresAt: head.order.expiresAt,
      paidAt: head.order.paidAt,
      fulfilledAt: head.order.fulfilledAt,
    },
    client: {
      id: head.clientId,
      displayName: head.clientDisplayName,
      telegramId: head.clientTelegramId,
      email: head.clientEmail,
    },
    serviceName: head.serviceName ?? head.order.customServiceDescription,
    assignedOperatorName: head.operatorName,
    // Обратно в хронологию: наверху карточки читают историю сверху вниз.
    events: [...eventRows].reverse().map((e) => ({
      id: e.id,
      eventType: e.eventType,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      actorType: e.actorType,
      actorId: e.actorId,
      payload: e.payload,
      createdAt: e.createdAt,
    })),
    payments: paymentRows.map((p) => ({
      id: p.id,
      provider: p.provider,
      providerRef: p.providerRef,
      providerInvoiceNumber: p.providerInvoiceNumber,
      amountRubKopecks: p.amountRub,
      status: p.status,
      lastProviderStatus: p.lastProviderStatus,
      lastProviderStatusAt: p.lastProviderStatusAt,
      createdAt: p.createdAt,
      completedAt: p.completedAt,
      expiresAt: p.expiresAt,
    })),
    // Явное перечисление полей, а не `...card`: строка карты не должна утекать
    // целиком, если в неё когда-нибудь добавят чувствительное поле.
    card: card
      ? {
          id: card.id,
          panMasked: card.panMasked,
          status: card.status,
          balanceUsdCents: card.balanceUsdCents,
          createdAt: card.createdAt,
        }
      : null,
  };
}

// ─── Карточка клиента (тикет 04) ──────────────────────────────────────────

export type PanelClientOrder = {
  id: string;
  shortId: string;
  status: OrderStatus;
  amountRubKopecks: number | null;
  serviceName: string | null;
  createdAt: Date;
};

export type PanelClientCard = {
  id: string;
  panMasked: string;
  status: CardStatus;
  balanceUsdCents: number;
  createdAt: Date;
};

export type PanelClientReferralLink = {
  id: string;
  displayName: string | null;
  telegramId: string | null;
};

export type PanelClientDetail = {
  client: {
    id: string;
    displayName: string | null;
    telegramId: string | null;
    /**
     * Есть ли веб-сессия. Именно ФЛАГ, а не сам `web_session_id`: его значение
     * — содержимое httpOnly-cookie клиента, то есть живой креденшл (`Cookie:
     * session=<uuid>` даёт полное олицетворение: история чата, статусы заказов,
     * создание заказа). Панели достаточно знать, что клиент пришёл с сайта.
     */
    hasWebSession: boolean;
    email: string | null;
    phone: string | null;
    /** Откуда телефон: `telegram` (верифицирован) или `manual` (ввели руками). */
    phoneSource: string | null;
    language: string;
    createdAt: Date;
  };
  orders: PanelClientOrder[];
  /**
   * Заказов и карт у клиента ВСЕГО и сумма состоявшихся — считаются в базе, а
   * не по срезу `orders`/`cards`: списки режутся потолком, и складывать их
   * значило бы молча занижать цифры у клиента со 100+ заказами.
   */
  totals: { ordersCount: number; purchasedRubKopecks: number; cardsCount: number };
  cards: PanelClientCard[];
  /** Кто привёл этого клиента. */
  referredBy: PanelClientReferralLink | null;
  /** Кого привёл он (потолок — как у списков). */
  referrals: PanelClientReferralLink[];
};

/**
 * Всё про клиента на одной странице (спека §5.3).
 *
 * ⚠️ Карты — ТОЛЬКО маскированные, как и в карточке заказа: панель не становится
 * третьим каналом выдачи реквизитов.
 *
 * `last_seen_ip` намеренно НЕ отдаётся: IP плательщика нужен антифрод-треку при
 * выставлении счёта, а на экране он лишь добавляет PII, которую менеджеру не с
 * чем сопоставить.
 */
export async function getClientDetailForPanel(
  db: DB,
  userId: string,
): Promise<PanelClientDetail | null> {
  const headRows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      telegramId: users.telegramId,
      webSessionId: users.webSessionId,
      email: users.email,
      phone: users.phone,
      phoneSource: users.phoneSource,
      language: users.language,
      createdAt: users.createdAt,
      referredBy: users.referredBy,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const head = headRows[0];
  if (!head) return null;

  const [orderRows, totalsRows, cardRows, referrerRows, referralRows] = await Promise.all([
    db
      .select({
        id: orders.id,
        shortId: orders.shortId,
        status: orders.status,
        amountRub: orders.amountRub,
        customServiceDescription: orders.customServiceDescription,
        serviceName: services.name,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .leftJoin(services, eq(orders.serviceId, services.id))
      .where(eq(orders.userId, userId))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(PANEL_MAX_ROWS),
    // Итоги — отдельным запросом по ВСЕМ заказам и картам клиента, а не по
    // видимому срезу: списки режутся потолком, и складывать их значило бы молча
    // занижать цифры у клиента со 100+ заказами. Набор «покупка состоялась»
    // берётся из общего `PURCHASED_STATUSES_SQL` — своя копия статусов ровно
    // то, против чего этот фрагмент и заведён.
    db.execute<{
      orders_count: string | number;
      purchased_sum: string | number | null;
      cards_count: string | number;
    }>(sql`
      SELECT count(*) AS orders_count,
             COALESCE(SUM(amount_rub) FILTER (
               WHERE status IN ${PURCHASED_STATUSES_SQL}
             ), 0) AS purchased_sum,
             (SELECT count(*) FROM cards WHERE user_id = ${userId}) AS cards_count
      FROM orders WHERE user_id = ${userId}
    `),
    db
      .select({
        id: cards.id,
        panMasked: cards.panMasked,
        status: cards.status,
        balanceUsdCents: cards.balanceUsdCents,
        createdAt: cards.createdAt,
      })
      .from(cards)
      .where(eq(cards.userId, userId))
      .orderBy(desc(cards.createdAt))
      .limit(PANEL_MAX_ROWS),
    head.referredBy
      ? db
          .select({
            id: users.id,
            displayName: users.displayName,
            telegramId: users.telegramId,
          })
          .from(users)
          .where(eq(users.id, head.referredBy))
          .limit(1)
      : Promise.resolve([]),
    db
      .select({
        id: users.id,
        displayName: users.displayName,
        telegramId: users.telegramId,
      })
      .from(users)
      .where(eq(users.referredBy, userId))
      .orderBy(desc(users.createdAt))
      .limit(PANEL_MAX_ROWS),
  ]);

  return {
    client: {
      id: head.id,
      displayName: head.displayName,
      telegramId: head.telegramId,
      hasWebSession: head.webSessionId !== null,
      email: head.email,
      phone: head.phone,
      phoneSource: head.phoneSource,
      language: head.language,
      createdAt: head.createdAt,
    },
    totals: {
      ordersCount: Number(totalsRows[0]?.orders_count ?? 0),
      purchasedRubKopecks: Number(totalsRows[0]?.purchased_sum ?? 0),
      cardsCount: Number(totalsRows[0]?.cards_count ?? 0),
    },
    orders: orderRows.map((row) => ({
      id: row.id,
      shortId: row.shortId,
      status: row.status,
      amountRubKopecks: row.amountRub,
      serviceName: row.serviceName ?? row.customServiceDescription,
      createdAt: row.createdAt,
    })),
    cards: cardRows,
    referredBy: referrerRows[0] ?? null,
    referrals: referralRows,
  };
}

// ─── Антифрод-холды Freekassa (тикет 05) ──────────────────────────────────

/**
 * Коды провайдера, означающие «деньги в подвешенном состоянии»: холд антифрода
 * и отказ. Берутся ИЗ `@oplati/types`, а не переписываются числами: копия
 * кодов — зеркало, которое разъедется молча, а цена ошибки здесь — заказ,
 * пропавший с экрана «что требует внимания».
 */
export const PANEL_HOLD_PROVIDER_STATUSES = [
  FREEKASSA_ORDER_STATUS.ANTIFRAUD_HOLD,
  FREEKASSA_ORDER_STATUS.ERROR,
  FREEKASSA_ORDER_STATUS.CANCELLED,
] as const;

/**
 * Окно для ТЕРМИНАЛЬНЫХ отказов. Заказ на проверке банка не протухает и висит
 * до исхода, а вот честно отменённый или отвергнутый счёт закрывать нечем — без
 * окна такие строки копились бы вечно, и экран, пустота которого означает
 * «холдов нет», зарастал бы разрешёнными историями.
 */
const HOLD_DECLINED_WINDOW_DAYS = 30;

export type PanelHoldClient = {
  id: string;
  displayName: string | null;
  telegramId: string | null;
};

export type PanelHoldRow = {
  orderId: string;
  shortId: string;
  orderStatus: OrderStatus;
  amountRubKopecks: number | null;
  orderCreatedAt: Date;
  /** Без email: экран холдов его не показывает, а лишняя PII в процессе,
   *  который держит вебхуки Freekassa и Telegram, ни к чему. */
  client: PanelHoldClient;
  paymentId: string | null;
  provider: string | null;
  providerRef: string | null;
  lastProviderStatus: number | null;
  /** Когда статус у провайдера сменился в последний раз. */
  lastProviderStatusAt: Date | null;
  /**
   * Когда клиенту РЕАЛЬНО ушло автосообщение о проверке банка (`null` — не
   * уходило). Читается фактом из журнала, а не выводится из статуса заказа:
   * отправка в `poll-payment` best-effort, её отказ (403 «бот заблокирован
   * пользователем») гасится log.warn — и экран уверял бы менеджера, что клиент
   * предупреждён, ровно там, где клиент сидит в тишине.
   */
  clientNotifiedAt: Date | null;
};

/**
 * ОБЩЕЕ условие «заказ на экране проверки платежей» — для списка и для
 * счётчика в меню (панель v2, тикет 13). Одно место, а не два: разъезд между
 * «что показывает экран» и «что считает бейдж» — зеркало, которое сверять
 * глазами никто не будет.
 *
 * Ожидает JOIN `payments` (LEFT) к `orders`.
 */
function holdsCondition() {
  return or(
    // Заказ на проверке банка не протухает — показываем всегда.
    eq(orders.status, 'payment_review'),
    and(
      inArray(payments.lastProviderStatus, [...PANEL_HOLD_PROVIDER_STATUSES]),
      // Уже доведённые заказы в список не тянем: там холд разрешился.
      inArray(orders.status, ['pending_payment', 'payment_review', 'failed']),
      sql`${orders.createdAt} > now() - interval '${sql.raw(String(HOLD_DECLINED_WINDOW_DAYS))} days'`,
    ),
  );
}

/**
 * Сколько заказов на экране проверки платежей — для счётчика в меню.
 * Считает ЗАКАЗЫ (distinct), как и список после дедупа платежей, без потолка:
 * бейдж обязан называть настоящее число, а не «100+».
 */
export async function countHoldsForPanel(db: DB): Promise<number> {
  const rows = await db
    .select({ cnt: countDistinct(orders.id) })
    .from(orders)
    .leftJoin(payments, eq(payments.orderId, orders.id))
    .where(holdsCondition());
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Заказы, которые банк держит на проверке, и платежи с холдом или отказом.
 *
 * Сегодня об этом узнают только через семь дней и только владелец (сторож
 * `payment-review-watch`). Экран показывает их с ПЕРВОГО дня.
 *
 * ⚠️ Действий по холду в панели нет: исход решает провайдер. Выборка нужна для
 * видимости и для текста обращения в поддержку Freekassa.
 */
export async function listHoldsForPanel(
  db: DB,
  limit?: number,
): Promise<{ items: PanelHoldRow[]; hasMore: boolean }> {
  // Дедуп идёт в JS, поэтому строк берём с запасом: несколько платежей у заказа
  // и одна строка сверх страницы (по ней и виден признак «есть ещё»).
  const sqlLimit = clampPanelLimit(limit) * 3 + 1;
  // Плюс ещё одна — ТОЛЬКО чтобы отличить «выбрали всё» от «упёрлись в потолок».
  // Без неё `rows.length === sqlLimit` означало и то и другое, и экран говорил
  // «показаны не все» там, где показаны все.
  const rows = await db
    .select({
      orderId: orders.id,
      shortId: orders.shortId,
      orderStatus: orders.status,
      amountRub: orders.amountRub,
      orderCreatedAt: orders.createdAt,
      clientId: users.id,
      clientDisplayName: users.displayName,
      clientTelegramId: users.telegramId,
      paymentId: payments.id,
      provider: payments.provider,
      providerRef: payments.providerRef,
      lastProviderStatus: payments.lastProviderStatus,
      lastProviderStatusAt: payments.lastProviderStatusAt,
    })
    .from(orders)
    .innerJoin(users, eq(orders.userId, users.id))
    .leftJoin(payments, eq(payments.orderId, orders.id))
    .where(holdsCondition())
    // Свежие заказы первыми, платежи внутри заказа — тоже свежие первыми: по
    // ним и выбирается строка ниже.
    .orderBy(desc(orders.createdAt), desc(orders.id), desc(payments.createdAt))
    .limit(sqlLimit + 1);

  const truncatedBySqlLimit = rows.length > sqlLimit;

  // У заказа может быть несколько платежей (частичный UNIQUE покрывает только
  // pending): показываем строку заказа один раз. Платежи отсортированы свежими
  // вперёд, поэтому берём ПЕРВЫЙ СО СТАТУСОМ ПРОВАЙДЕРА. Прежняя версия брала
  // любой ненулевой и на паре «первый счёт 8, перевыставленный 7» показывала
  // устаревший код.
  //
  // ⚠️ Правило именно такое, а не «самый свежий платёж»: свежий счёт может быть
  // ещё не опрошен (`last_provider_status IS NULL`), и строка тогда потеряла бы
  // и причину попадания на экран, и номер операции, по которому в поддержку
  // Freekassa задают вопрос. Держать деньги банк может только по той операции,
  // которую провайдер и пометил, — её и показываем.
  const byOrder = new Map<string, PanelHoldRow>();
  for (const row of rows.slice(0, sqlLimit)) {
    const existing = byOrder.get(row.orderId);
    if (existing && existing.lastProviderStatus !== null) continue;
    byOrder.set(row.orderId, {
      orderId: row.orderId,
      shortId: row.shortId,
      orderStatus: row.orderStatus,
      amountRubKopecks: row.amountRub,
      orderCreatedAt: row.orderCreatedAt,
      client: {
        id: row.clientId,
        displayName: row.clientDisplayName,
        telegramId: row.clientTelegramId,
      },
      paymentId: row.paymentId,
      provider: row.provider,
      providerRef: row.providerRef,
      lastProviderStatus: row.lastProviderStatus,
      lastProviderStatusAt: row.lastProviderStatusAt,
      // Заполняется вторым запросом ниже: пусто ровно там, где факта нет.
      clientNotifiedAt: null,
    });
  }

  const items = [...byOrder.values()];
  const maxRows = clampPanelLimit(limit);
  const page = items.slice(0, maxRows);
  await attachClientNotifiedAt(db, page);
  // «Есть ещё» — не только когда заказов набралось больше страницы. Запас в три
  // платежа на заказ может и не покрыть заказ с длинной историей перевыставлений:
  // упёршись в потолок SQL, мы просто НЕ ЗНАЕМ, что дальше, и молчать об этом
  // нельзя — пустой хвост читается как «холдов больше нет».
  return { items: page, hasMore: items.length > maxRows || truncatedBySqlLimit };
}

/**
 * Дописывает факт доставки автосообщения о проверке банка.
 *
 * Отдельным запросом, а не подзапросом в общей выборке: сырой `sql` вернул бы
 * timestamptz как есть, и тип значения зависел бы от драйвера (PGlite в тестах
 * и postgres-js на проде расходятся — этот класс расхождений уже стоил нам
 * инцидента 2026-08-15). Через builder дату разбирает тот же маппер, что и
 * везде. Цена — один лишний round-trip на экран максимум в сто строк.
 */
async function attachClientNotifiedAt(db: DB, rows: PanelHoldRow[]): Promise<void> {
  const byOrderId = await latestEventAtByOrder(
    db,
    rows.map((r) => r.orderId),
    PAYMENT_REVIEW_CLIENT_NOTIFIED_EVENT,
  );
  for (const row of rows) row.clientNotifiedAt = byOrderId.get(row.orderId) ?? null;
}

/** Когда по каждому заказу последний раз случалось событие данного типа. */
async function latestEventAtByOrder(
  db: DB,
  orderIds: readonly string[],
  eventType: string,
): Promise<Map<string, Date | null>> {
  // Пустой список отдельным случаем: `inArray(col, [])` разворачивается в
  // `IN ()` — синтаксическую ошибку.
  if (orderIds.length === 0) return new Map();

  const rows = await db
    .select({ orderId: orderEvents.orderId, at: max(orderEvents.createdAt) })
    .from(orderEvents)
    .where(and(inArray(orderEvents.orderId, [...orderIds]), eq(orderEvents.eventType, eventType)))
    .groupBy(orderEvents.orderId);

  return new Map(rows.map((r) => [r.orderId, r.at]));
}

// ─── Недожатые заказы (тикет 07) ──────────────────────────────────────────

/**
 * Статусы «клиент оформил, но не заплатил». Оба — намеренно:
 * `ready_for_payment` (счёт даже не выставлялся) и `pending_payment` (счёт
 * есть, оплаты нет). Из 138 просроченных заказов 97 не дошли до счёта — вторая
 * половина потери живёт именно в первом статусе, и прятать её нельзя.
 */
export const PANEL_PENDING_ORDER_STATUSES = ['ready_for_payment', 'pending_payment'] as const;

/** Тот же список SQL-фрагментом — собирается ИЗ него, копии значений нет. */
const PENDING_STATUSES_SQL = sql`(${sql.join(
  PANEL_PENDING_ORDER_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)})`;

export type PanelPendingOrder = {
  orderId: string;
  shortId: string;
  status: OrderStatus;
  amountRubKopecks: number | null;
  createdAt: Date;
  /** Срок ЗАКАЗА (фиксация цены либо срок счёта — их выравнивает payments). */
  expiresAt: Date | null;
  serviceName: string | null;
  client: PanelHoldClient;
  /** Живой (pending) счёт заказа, если он есть. */
  invoice: {
    paymentId: string;
    expiresAt: Date | null;
    /** Ссылка на оплату из снимка инвойса. Без неё отправлять нечего. */
    paymentUrl: string | null;
    /**
     * Кто выставил счёт. Нужен НЕ для витрины: у шлюзов разная надбавка
     * покупателя, и напоминание обязано назвать ту же цену, что клиент увидит
     * на странице оплаты. Берётся у счёта, а не у текущего
     * `PAYMENT_PRIMARY_PROVIDER`: переключение шлюза не меняет условия по уже
     * выставленному счёту.
     */
    provider: string;
  } | null;
  /** Когда менеджер напоминал в последний раз (дедуп — сутки). */
  lastRemindedAt: Date | null;
  /**
   * Когда доставка напоминания СОРВАЛАСЬ.
   *
   * ⚠️ Отдельным полем, потому что окно суток занимается ДО отправки и вернуть
   * его нечем (`order_events` append-only). Без этого экран показывал бы
   * «напоминали в 14:20» там, где клиент не получил ничего: менеджер считает
   * заказ обработанным, повторить не может ещё сутки, и узнать о недоставке
   * ему неоткуда.
   */
  lastRemindFailedAt: Date | null;
};

/**
 * Заказы, которые клиент оформил и не оплатил (спека §5.5).
 *
 * Самая большая денежная потеря на сегодня. Поток около одного заказа в день,
 * поэтому ценность экрана не в объёме, а в том, что ни одна строка не теряется
 * молча — отсюда и явный признак усечения.
 *
 * Ссылка на оплату достаётся ЗДЕСЬ, выражением по `raw_payload`: отдельной
 * колонки под неё нет, а разбирать снимок инвойса в двух местах (список и
 * операция) значило бы завести зеркало на денежном пути.
 */
export async function listPendingOrdersForPanel(
  db: DB,
  opts: { limit?: number; shortId?: string; userId?: string } = {},
): Promise<{ items: PanelPendingOrder[]; hasMore: boolean }> {
  const maxRows = clampPanelLimit(opts.limit);
  // Фильтры сужают ту же выборку, а не заводят вторую:
  //   `shortId` — для ОПЕРАЦИИ (она обязана решать «живой ли счёт» тем же кодом,
  //     что и экран, но искать заказ перебором страницы нельзя: за потолком
  //     списка напоминание отдавало бы «заказ не найден» вместо отправки);
  //   `userId` — точка изоляции для тестов и будущей карточки клиента. Без неё
  //     проверка «есть ещё» на общей базе тождественно истинна и не значит
  //     ничего (находка ревью).
  const conditions = [inArray(orders.status, [...PANEL_PENDING_ORDER_STATUSES])];
  if (opts.shortId) conditions.push(// ⚠️ Точное сравнение, не ILIKE: `ORD-%` иначе выбрал бы СТАРЕЙШИЙ недожатый
    // заказ (сортировка по возрастанию даты) и отправил бы его клиенту
    // платёжную ссылку. Схема адреса такую строку сегодня не пропускает, но
    // защита от неё не должна жить в одном месте.
    eq(orders.shortId, opts.shortId.trim().toUpperCase()));
  if (opts.userId) conditions.push(eq(orders.userId, opts.userId));

  const rows = await db
    .select({
      orderId: orders.id,
      shortId: orders.shortId,
      status: orders.status,
      amountRub: orders.amountRub,
      createdAt: orders.createdAt,
      expiresAt: orders.expiresAt,
      customServiceDescription: orders.customServiceDescription,
      serviceName: services.name,
      clientId: users.id,
      clientDisplayName: users.displayName,
      clientTelegramId: users.telegramId,
      paymentId: payments.id,
      paymentExpiresAt: payments.expiresAt,
      paymentProvider: payments.provider,
      // `-> 'invoice' ->> 'paymentLink'` — конверт снимка инвойса общий для
      // обоих шлюзов (см. lib/payments/gateway.ts), поэтому список не знает,
      // кто выставил счёт.
      paymentUrl: sql<
        string | null
      >`${payments.rawPayload} -> 'invoice' ->> 'paymentLink'`,
    })
    .from(orders)
    .innerJoin(users, eq(orders.userId, users.id))
    .leftJoin(services, eq(orders.serviceId, services.id))
    // Только ЖИВОЙ счёт: терминальные платежи прошлых попыток к напоминанию
    // отношения не имеют, а частичный UNIQUE гарантирует, что живой один.
    .leftJoin(payments, and(eq(payments.orderId, orders.id), eq(payments.status, 'pending')))
    .where(and(...conditions))
    // Старые сверху: они горят. Возраст и есть причина, по которой экран нужен.
    .orderBy(asc(orders.createdAt), asc(orders.id))
    .limit(maxRows + 1);

  const hasMore = rows.length > maxRows;
  const items = rows.slice(0, maxRows).map((row) => ({
    orderId: row.orderId,
    shortId: row.shortId,
    status: row.status,
    amountRubKopecks: row.amountRub,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    serviceName: row.serviceName ?? row.customServiceDescription,
    client: {
      id: row.clientId,
      displayName: row.clientDisplayName,
      telegramId: row.clientTelegramId,
    },
    invoice: row.paymentId
      ? {
          paymentId: row.paymentId,
          expiresAt: row.paymentExpiresAt,
          paymentUrl: row.paymentUrl,
          provider: row.paymentProvider ?? '',
        }
      : null,
    lastRemindedAt: null as Date | null,
    lastRemindFailedAt: null as Date | null,
  }));

  const orderIds = items.map((i) => i.orderId);
  const [remindedAt, failedAt] = await Promise.all([
    latestEventAtByOrder(db, orderIds, PAYMENT_REMINDER_SENT_EVENT),
    latestEventAtByOrder(db, orderIds, PAYMENT_REMINDER_FAILED_EVENT),
  ]);
  for (const item of items) {
    item.lastRemindedAt = remindedAt.get(item.orderId) ?? null;
    item.lastRemindFailedAt = failedAt.get(item.orderId) ?? null;
  }

  return { items, hasMore };
}

/**
 * Сколько всего недожатых заказов и на какую сумму.
 *
 * Отдельным запросом, потому что рабочий стол показывает ПЯТЬ строк, а число и
 * деньги обязан называть настоящие: «5+ на 50 000 ₽» при сорока заказах на
 * 200 000 ₽ — то же занижение по видимому срезу, которое пачка 3 уже запретила
 * себе на карточке клиента.
 */
export async function countPendingOrdersForPanel(
  db: DB,
): Promise<{ count: number; sumKopecks: number }> {
  const rows = await db.execute<{ cnt: string | number; total: string | number | null }>(sql`
    SELECT count(*) AS cnt, COALESCE(SUM(amount_rub), 0) AS total
    FROM orders
    WHERE status IN ${PENDING_STATUSES_SQL}
  `);
  return {
    count: Number(rows[0]?.cnt ?? 0),
    sumKopecks: Number(rows[0]?.total ?? 0),
  };
}

// ─── Поддержка (тикет 10) ─────────────────────────────────────────────────

// Ключи отметки «обращение подано» — общие с писателем (`@oplati/types`):
// зеркала здесь нет, значение одно на оба пакета.

export type PanelSupportRequest = {
  conversationId: string;
  client: PanelHoldClient;
  /** Когда клиент обратился в последний раз. */
  lastRequestAt: Date;
  /** Дошло ли последнее обращение до оператора (false — авария конфигурации). */
  lastRequestDelivered: boolean;
  /**
   * Когда оператор ответил НА ПОСЛЕДНЕЕ обращение (`null` — не ответил).
   * Именно на последнее: разговор один на клиента, и «когда-то отвечали»
   * означало бы, что повторное обращение постоянного клиента навсегда
   * числится отвеченным.
   */
  lastOperatorReplyAt: Date | null;
  /** Кто ведёт диалог. */
  assignedOperatorName: string | null;
  handoffMode: string;
};

/**
 * Обращения в поддержку (спека §5.6). Единица — РАЗГОВОР, а не сообщение:
 * «кто ведёт» и «подключиться» живут на `conversations`.
 *
 * Свежие сверху: у обращения ценность падает с каждым часом молчания.
 */
export async function listSupportRequestsForPanel(
  db: DB,
  opts: { limit?: number; userId?: string } = {},
): Promise<{ items: PanelSupportRequest[]; hasMore: boolean }> {
  const maxRows = clampPanelLimit(opts.limit);

  // ⚠️ Идём ОТ СООБЩЕНИЙ, а не от разговоров. LATERAL по всей таблице
  // `conversations` выполнялся бы для каждой её строки, а она не чистится
  // ретеншеном и растёт бессрочно — при живом обновлении раз в 25 секунд это
  // линейная по всей истории стоимость на каждой открытой вкладке. Обращения
  // живут в `messages`, и там есть индекс `(conversation_id, created_at)`.
  const conditions = [sql`(m.meta ->> ${SUPPORT_REQUEST_META_KEY}) = 'true'`];
  if (opts.userId) conditions.push(sql`c.user_id = ${opts.userId}`);

  const rows = await db.execute<{
    conversation_id: string;
    user_id: string;
    display_name: string | null;
    telegram_id: string | null;
    last_request_at: Date | string;
    last_delivered: boolean | string | null;
    last_reply_at: Date | string | null;
    operator_name: string | null;
    handoff_mode: string;
  }>(sql`
    WITH requests AS (
      SELECT m.conversation_id,
             max(m.created_at) AS last_request_at,
             (array_agg(m.meta ->> ${SUPPORT_DELIVERED_META_KEY}
                        ORDER BY m.created_at DESC))[1] AS last_delivered
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE ${sql.join(conditions, sql` AND `)}
      GROUP BY m.conversation_id
      ORDER BY max(m.created_at) DESC
      LIMIT ${maxRows + 1}
    )
    SELECT c.id AS conversation_id,
           u.id AS user_id,
           u.display_name,
           u.telegram_id,
           r.last_request_at,
           r.last_delivered,
           -- Ответ ПОСЛЕ последнего обращения, а не любой в истории: разговор
           -- один на клиента, и постоянный клиент, которому когда-то отвечали,
           -- иначе навсегда числился бы отвеченным.
           (SELECT max(o.created_at) FROM messages o
             WHERE o.conversation_id = c.id
               AND o.role = 'operator'
               AND o.created_at > r.last_request_at) AS last_reply_at,
           s.display_name AS operator_name,
           c.handoff_mode
    FROM requests r
    JOIN conversations c ON c.id = r.conversation_id
    JOIN users u ON u.id = c.user_id
    LEFT JOIN staff s ON s.id = c.assigned_operator_id
    ORDER BY r.last_request_at DESC
  `);

  const hasMore = rows.length > maxRows;
  const items = rows.slice(0, maxRows).map((row) => ({
    conversationId: row.conversation_id,
    client: {
      id: row.user_id,
      displayName: row.display_name,
      telegramId: row.telegram_id,
    },
    lastRequestAt: new Date(row.last_request_at),
    // `null` в отметке — обращения ДО появления признака (18 августа): про них
    // мы не знаем, дошли ли они, и «не доставлено» было бы напраслиной.
    lastRequestDelivered: row.last_delivered === null ? true : String(row.last_delivered) === 'true',
    lastOperatorReplyAt: row.last_reply_at === null ? null : new Date(row.last_reply_at),
    assignedOperatorName: row.operator_name,
    handoffMode: row.handoff_mode,
  }));

  return { items, hasMore };
}

export type PanelSupportMessage = {
  id: string;
  role: string;
  content: string;
  /** Имя сотрудника для строк оператора. */
  staffName: string | null;
  /**
   * Meta строки — панели она нужна для двух вещей: отличить ответ ПОМОЩНИКА
   * (`source: 'support_ai'`) от прочих ответов бота и показать у служебной
   * строки перехода триггер и причину. Наружу из панели не уходит.
   */
  meta: Record<string, unknown> | null;
  createdAt: Date;
};

export type PanelSupportThread = {
  conversationId: string;
  client: PanelHoldClient & { id: string };
  assignedOperatorId: string | null;
  assignedOperatorName: string | null;
  handoffMode: string;
  messages: PanelSupportMessage[];
  /**
   * Сообщений больше, чем показано. Переписка старше 90 дней удаляется кроном
   * `retention` — обрыв ленты объясняется на экране, а не выглядит потерей.
   */
  hasMore: boolean;
};

/** Лента переписки для карточки обращения. Старые → новые, как её читают. */
export async function getSupportThreadForPanel(
  db: DB,
  conversationId: string,
  limit?: number,
): Promise<PanelSupportThread | null> {
  const maxRows = clampPanelLimit(limit);

  const headRows = await db
    .select({
      conversationId: conversations.id,
      handoffMode: conversations.handoffMode,
      assignedOperatorId: conversations.assignedOperatorId,
      operatorName: staff.displayName,
      clientId: users.id,
      clientDisplayName: users.displayName,
      clientTelegramId: users.telegramId,
    })
    .from(conversations)
    .innerJoin(users, eq(conversations.userId, users.id))
    .leftJoin(staff, eq(conversations.assignedOperatorId, staff.id))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const head = headRows[0];
  if (!head) return null;

  // Свежие первыми в SQL, разворот в JS: LIMIT по хвосту — единственный способ
  // показать КОНЕЦ длинной переписки, а читают её сверху вниз.
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      staffName: staff.displayName,
      meta: messages.meta,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(staff, eq(messages.staffId, staff.id))
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(maxRows + 1);

  const hasMore = rows.length > maxRows;
  const page = rows.slice(0, maxRows).reverse();

  return {
    conversationId: head.conversationId,
    client: {
      id: head.clientId,
      displayName: head.clientDisplayName,
      telegramId: head.clientTelegramId,
    },
    assignedOperatorId: head.assignedOperatorId,
    assignedOperatorName: head.operatorName,
    handoffMode: head.handoffMode,
    messages: page.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      staffName: row.staffName,
      meta: row.meta,
      createdAt: row.createdAt,
    })),
    hasMore,
  };
}

/**
 * «Подключиться к диалогу»: закрепить обращение за сотрудником.
 *
 * ⚠️ Занимает диалог ТОЛЬКО если он свободен либо уже за этим же сотрудником —
 * иначе двое отвечают одному клиенту, а на экране видно имя первого. Возвращает
 * `false` проигравшему: это не ошибка, а «занято коллегой».
 */
export async function claimSupportConversation(
  db: DB,
  input: { conversationId: string; staffId: string },
): Promise<'claimed' | 'taken' | 'not_found'> {
  // Через ЕДИНСТВЕННОГО писателя режима — иначе «подключиться» было бы
  // вторым, рукописным UPDATE тех же колонок рядом с `transitionConversationMode`,
  // и правило про `mode_expires_at` жило бы в двух местах.
  //
  // ⚠️ Срок = NULL: «подключиться» — это «беру себе», а не «ответил».
  // Неотвеченное обращение не гаснет никогда (спека §1); разговор приходит
  // сюда из режима помощника со сроком «+30 минут», и сохранённый срок
  // означал бы, что крон закроет обращение, на которое никто не ответил.
  const res = await transitionConversationMode(db, {
    conversationId: input.conversationId,
    from: ['idle', 'ai', 'operator'],
    to: 'operator',
    trigger: 'operator_claim',
    modeExpiresAt: null,
    assignedOperatorId: input.staffId,
    onlyIfFreeOrOwnedBy: input.staffId,
  });
  if (res.transitioned) return 'claimed';
  // Отличаем «занято коллегой» от «диалога нет»: одинаковый ответ отправлял бы
  // менеджера искать несуществующего коллегу.
  return res.state ? 'taken' : 'not_found';
}

/**
 * Сколько обращений ждут ответа оператора — по ВСЕЙ базе, а не по видимому
 * срезу.
 *
 * Рабочий стол показывает пять свежих строк. Считать «неотвеченные» по ним
 * значит утверждать «все обращения отвечены» ровно в случае, который экран и
 * должен ловить: клиент написал вчера, ему не ответили, сегодня пришло пять
 * новых и отвеченных.
 */
export async function countUnansweredSupportRequests(db: DB): Promise<number> {
  // ⚠️ Идём ОТ СООБЩЕНИЙ, как и соседний `listSupportRequestsForPanel`. LATERAL
  // по `conversations` выполнялся для КАЖДОЙ её строки, а эта таблица
  // ретеншеном не чистится и растёт вместе с числом клиентов навсегда. Рабочий
  // стол обновляется раз в 25 секунд на каждой открытой вкладке, и всё это — в
  // том же процессе, что принимает вебхуки платежей.
  const rows = await db.execute<{ cnt: string | number }>(sql`
    WITH requests AS (
      SELECT m.conversation_id, max(m.created_at) AS last_request_at
      FROM messages m
      WHERE (m.meta ->> ${SUPPORT_REQUEST_META_KEY}) = 'true'
      GROUP BY m.conversation_id
    )
    SELECT count(*) AS cnt
    FROM requests r
    WHERE NOT EXISTS (
      SELECT 1 FROM messages o
      WHERE o.conversation_id = r.conversation_id
        AND o.role = 'operator'
        AND o.created_at > r.last_request_at
    )
  `);
  return Number(rows[0]?.cnt ?? 0);
}

// ─── Партнёры и заявки на вывод (тикет 12) ────────────────────────────────

export type PanelPartner = {
  userId: string;
  displayName: string | null;
  telegramId: string | null;
  /** Сколько клиентов привёл (первый уровень — программа одноуровневая). */
  referralsCount: number;
  /** Начислено минус отменено, USD-центы. */
  accruedUsdCents: number;
  /** Доступно к выводу: начислено − отменено − заявки (кроме отклонённых). */
  balanceUsdCents: number;
  /**
   * Ставка партнёра, bps. Берётся ТОЛЬКО из `referral_partners.locked_rate_l1_bps`
   * — единственного источника по решению владельца от 11 августа. Второго места,
   * где живёт ставка, панель не создаёт.
   */
  lockedRateL1Bps: number;
  /** Антифрод-блок: исключён из начислений, вывод заморожен. */
  suspended: boolean;
  /**
   * Есть ли строка в `referral_partners`. Её создаёт ТОЛЬКО месячный роллап,
   * поэтому у заработавшего в этом месяце профиля ещё нет, а ставка и блок
   * показываются дефолтные.
   */
  hasProfile: boolean;
};

/**
 * Партнёры с деньгами (спека §5.7).
 *
 * ⚠️ Начисления append-only: суммы руками не правятся ни здесь, ни где-либо
 * ещё. Гашение делается компенсирующей строкой `reversed`, как сегодня.
 */
export async function listReferralPartnersForPanel(
  db: DB,
  opts: { limit?: number } = {},
): Promise<{ items: PanelPartner[]; hasMore: boolean }> {
  const maxRows = clampPanelLimit(opts.limit);

  const rows = await db.execute<{
    user_id: string;
    display_name: string | null;
    telegram_id: string | null;
    referrals_count: string | number;
    accrued: string | number | null;
    balance: string | number | null;
    locked_rate_l1_bps: number | null;
    suspended: boolean | null;
  }>(sql`
    WITH partner_ids AS (
      SELECT DISTINCT beneficiary_user_id AS user_id FROM referral_accruals
      UNION
      SELECT user_id FROM referral_partners
    )
    SELECT i.user_id,
           u.display_name,
           u.telegram_id,
           p.locked_rate_l1_bps,
           p.suspended,
           (SELECT count(*) FROM users r WHERE r.referred_by = i.user_id) AS referrals_count,
           COALESCE((SELECT SUM(CASE WHEN a.status = 'accrued' THEN a.amount_usd_cents
                                     WHEN a.status = 'reversed' THEN -a.amount_usd_cents
                                     ELSE 0 END)
                       FROM referral_accruals a
                      WHERE a.beneficiary_user_id = i.user_id), 0) AS accrued,
           ${balanceExpr(sql`i.user_id`)}::bigint AS balance
    FROM partner_ids i
    JOIN users u ON u.id = i.user_id
    LEFT JOIN referral_partners p ON p.user_id = i.user_id
    ORDER BY accrued DESC, i.user_id
    LIMIT ${maxRows + 1}
  `);

  const hasMore = rows.length > maxRows;
  const items = rows.slice(0, maxRows).map((row) => {
    const accruedUsdCents = Number(row.accrued ?? 0);
    return {
      userId: row.user_id,
      displayName: row.display_name,
      telegramId: row.telegram_id,
      referralsCount: Number(row.referrals_count ?? 0),
      accruedUsdCents,
      // ⚠️ Баланс считает ОБЩИЙ `balanceExpr` — то же выражение, что видит сам
      // партнёр в кабинете. Своя копия формулы на денежном экране разошлась бы
      // с кабинетом молча, без единого падения.
      balanceUsdCents: Number(row.balance ?? 0),
      // Профиля может не быть: ставка тогда дефолтная - ровно та, по которой
      // начисление и посчитано (`getPartnerProfile` при отсутствии строки
      // возвращает null и расчёт падает на дефолт).
      lockedRateL1Bps: row.locked_rate_l1_bps ?? DEFAULT_REFERRAL_RATE_L1_BPS,
      hasProfile: row.locked_rate_l1_bps !== null,
      suspended: row.suspended ?? false,
    };
  });

  return { items, hasMore };
}

/** Приглашённый партнёром клиент: сколько заказов и сколько денег принёс. */
export type PanelPartnerReferral = {
  userId: string;
  displayName: string | null;
  telegramId: string | null;
  /** Все заказы клиента, включая несостоявшиеся. */
  ordersCount: number;
  /** Копейки по СОСТОЯВШИМСЯ заказам (`PURCHASED_ORDER_STATUSES`). */
  purchasedRubKopecks: number;
};

export async function listPartnerReferralsForPanel(
  db: DB,
  partnerUserId: string,
  opts: { limit?: number } = {},
): Promise<{ items: PanelPartnerReferral[]; hasMore: boolean }> {
  const maxRows = clampPanelLimit(opts.limit);

  const rows = await db.execute<{
    user_id: string;
    display_name: string | null;
    telegram_id: string | null;
    orders_count: string | number;
    purchased: string | number | null;
  }>(sql`
    SELECT u.id AS user_id,
           u.display_name,
           u.telegram_id,
           (SELECT count(*) FROM orders o WHERE o.user_id = u.id) AS orders_count,
           COALESCE((SELECT SUM(o.amount_rub) FROM orders o
                      WHERE o.user_id = u.id
                        AND o.status IN ${PURCHASED_STATUSES_SQL}), 0) AS purchased
    FROM users u
    WHERE u.referred_by = ${partnerUserId}
    ORDER BY purchased DESC, u.created_at DESC
    LIMIT ${maxRows + 1}
  `);

  const hasMore = rows.length > maxRows;
  const items = rows.slice(0, maxRows).map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    telegramId: row.telegram_id,
    ordersCount: Number(row.orders_count ?? 0),
    purchasedRubKopecks: Number(row.purchased ?? 0),
  }));

  return { items, hasMore };
}

export type PanelPayoutRequest = {
  payoutId: string;
  userId: string;
  displayName: string | null;
  telegramId: string | null;
  amountUsdCents: number;
  status: string;
  method: string | null;
  feeUsdCents: number | null;
  requestedAt: Date;
  settledAt: Date | null;
  /** Баланс партнёра на сейчас — чтобы видеть, чем заявка обеспечена. */
  balanceUsdCents: number;
  /**
   * Партнёр заблокирован антифродом. Кабинет не даёт ему подать заявку, но
   * поданная ДО блокировки живёт в `requested` — и без пометки владелец провёл
   * бы выплату, не зная о блоке.
   */
  suspended: boolean;
};

/**
 * Заявки на вывод (спека §5.7, §6.4).
 *
 * ⚠️ Реквизиты (`destination`) наружу НЕ отдаются: там маскированный номер
 * карты или адрес кошелька, и панели для решения «выплатить или отклонить» они
 * не нужны — владелец берёт их из своего кабинета выплат.
 */
export async function listReferralPayoutsForPanel(
  db: DB,
  opts: { limit?: number; onlyOpen?: boolean } = {},
): Promise<{ items: PanelPayoutRequest[]; hasMore: boolean }> {
  const maxRows = clampPanelLimit(opts.limit);
  const openOnly = opts.onlyOpen
    ? sql`WHERE p.status IN ('requested', 'processing')`
    : sql``;

  const rows = await db.execute<{
    payout_id: string;
    user_id: string;
    display_name: string | null;
    telegram_id: string | null;
    amount_usd_cents: number;
    status: string;
    method: string | null;
    fee_usd_cents: number | null;
    requested_at: Date | string;
    settled_at: Date | string | null;
    balance: string | number | null;
    suspended: boolean | null;
  }>(sql`
    SELECT p.id AS payout_id,
           p.user_id,
           u.display_name,
           u.telegram_id,
           rp.suspended,
           p.amount_usd_cents,
           p.status,
           p.method,
           p.fee_usd_cents,
           p.requested_at,
           p.settled_at,
           -- Баланс — общим выражением balanceExpr: владелец решает по заявке,
           -- глядя на это число, и оно обязано совпадать с тем, что видит сам
           -- партнёр в кабинете. Своя копия формулы разошлась бы молча.
           ${balanceExpr(sql`p.user_id`)}::bigint AS balance
    FROM referral_payouts p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN referral_partners rp ON rp.user_id = p.user_id
    ${openOnly}
    ORDER BY p.requested_at DESC
    LIMIT ${maxRows + 1}
  `);

  const hasMore = rows.length > maxRows;
  const items = rows.slice(0, maxRows).map((row) => ({
    payoutId: row.payout_id,
    userId: row.user_id,
    displayName: row.display_name,
    telegramId: row.telegram_id,
    amountUsdCents: Number(row.amount_usd_cents),
    status: row.status as PayoutStatus,
    method: row.method,
    feeUsdCents: row.fee_usd_cents === null ? null : Number(row.fee_usd_cents),
    requestedAt: new Date(row.requested_at),
    settledAt: row.settled_at === null ? null : new Date(row.settled_at),
    balanceUsdCents: Number(row.balance ?? 0),
    suspended: row.suspended ?? false,
  }));

  return { items, hasMore };
}
