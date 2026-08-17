import { and, asc, desc, eq, inArray, ilike, or, sql } from 'drizzle-orm';

import type { OrderStatus } from '@oplati/types';

import { cards, orderEvents, orders, payments, services, staff, users } from '../schema.ts';
import type { DB } from '../index.ts';

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
  status: string;
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
  status: string;
  balanceUsdCents: number;
  createdAt: Date;
};

export type PanelOrderDetail = {
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
