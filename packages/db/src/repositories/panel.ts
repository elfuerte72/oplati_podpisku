import { and, asc, desc, eq, inArray, ilike, or, sql } from 'drizzle-orm';

import { FREEKASSA_ORDER_STATUS, PURCHASED_ORDER_STATUSES, type OrderStatus } from '@oplati/types';

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

/** Статусы «покупка состоялась» в виде SQL-списка — один источник на проект. */
function purchasedStatusesSql() {
  return sql`(${sql.join(
    PURCHASED_ORDER_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  )})`;
}

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
  status: string;
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
   * Заказов у клиента ВСЕГО и сумма состоявшихся — считаются в базе, а не по
   * срезу `orders`: список режется потолком, и складывать его значило бы молча
   * занижать денежную цифру у клиента со 100+ заказами.
   */
  totals: { ordersCount: number; purchasedRubKopecks: number };
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
    // Итоги — отдельным запросом по ВСЕМ заказам клиента. Набор «покупка
    // состоялась» берётся из `PURCHASED_ORDER_STATUSES`: своя копия статусов
    // — ровно то, против чего эта константа и заведена.
    db.execute<{ orders_count: string | number; purchased_sum: string | number | null }>(sql`
      SELECT count(*) AS orders_count,
             COALESCE(SUM(amount_rub) FILTER (
               WHERE status IN ${purchasedStatusesSql()}
             ), 0) AS purchased_sum
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
};

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
    .where(
      or(
        // Заказ на проверке банка не протухает — показываем всегда.
        eq(orders.status, 'payment_review'),
        and(
          inArray(payments.lastProviderStatus, [...PANEL_HOLD_PROVIDER_STATUSES]),
          // Уже доведённые заказы в список не тянем: там холд разрешился.
          inArray(orders.status, ['pending_payment', 'payment_review', 'failed']),
          sql`${orders.createdAt} > now() - interval '${sql.raw(String(HOLD_DECLINED_WINDOW_DAYS))} days'`,
        ),
      ),
    )
    // Свежие заказы первыми, платежи внутри заказа — тоже свежие первыми: по
    // ним и выбирается строка ниже.
    .orderBy(desc(orders.createdAt), desc(orders.id), desc(payments.createdAt))
    // Дедуп идёт в JS, поэтому потолок берём с запасом на несколько платежей у
    // заказа и на одну строку сверх страницы (признак «есть ещё»).
    .limit(clampPanelLimit(limit) * 3 + 1);

  // У заказа может быть несколько платежей (частичный UNIQUE покрывает только
  // pending): показываем строку заказа один раз. Платежи отсортированы свежими
  // вперёд, поэтому берём ПЕРВЫЙ со статусом провайдера — то есть последнее,
  // что провайдер о заказе сказал. Прежняя версия брала любой ненулевой и на
  // паре «первый счёт 8, перевыставленный 7» показывала устаревший код.
  const byOrder = new Map<string, PanelHoldRow>();
  for (const row of rows) {
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
    });
  }

  const items = [...byOrder.values()];
  const max = clampPanelLimit(limit);
  return { items: items.slice(0, max), hasMore: items.length > max };
}
