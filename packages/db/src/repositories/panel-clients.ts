import { sql, type SQL } from 'drizzle-orm';

import type { ConversationMode } from '@oplati/types';

import type { DB } from '../index.ts';
import { PURCHASED_STATUSES_SQL } from './order-status-sql.ts';
import { clampPanelLimit, clampPanelOffset } from './panel.ts';

/**
 * Раздел «Клиенты» админ-панели: список всех клиентов с итогами и лента
 * действий одного клиента.
 *
 * Отдельный модуль, а не продолжение `panel.ts`: тот вырос до двух тысяч строк
 * и читается уже с трудом. Границы те же — выборки ТОЛЬКО здесь, потолки
 * страницы общие с остальной панелью (`clampPanelLimit`), деньги — integer
 * копейки (инвариант 3).
 *
 * ⚠️ Что наружу НЕ отдаётся: `web_session_id` (живой креденшл сессии сайта),
 * `last_seen_ip` (антифроду нужен, менеджеру не с чем сопоставить),
 * `subscription_url` VPN (ссылка-подписка — секрет клиента), телефон и почта
 * ЦЕЛИКОМ в списке (только факт «есть»; значения показывает карточка).
 *
 * «Покупка состоялась» — общий `PURCHASED_STATUSES_SQL`: тот же список, по
 * которому карточка клиента считает «Оплачено» и раздел «Отчёты» — оплаченные
 * заказы. Своя копия здесь разъехалась бы молча.
 */

/**
 * Сегменты списка. Ключи — они же значения адреса `?seg=` (ссылку пересылают
 * коллеге), поэтому не переименовываются.
 *
 * Три сегмента по ИСХОДУ заказов делят базу без остатка (экран показывает их
 * счётчики рядом, и сумма обязана сходиться с «Все»):
 *   - `buyers`      — есть хотя бы одна состоявшаяся покупка;
 *   - `tried`       — оформлял заказ, но покупка не состоялась ни разу;
 *   - `lurkers`     — зашёл и ничего не оформил.
 * Два — сквозные признаки поверх исхода:
 *   - `unreachable` — без Telegram: написать некуда (оформлял на сайте и не привязал);
 *   - `stuck`       — деньги приняты, а заказ в «Ошибке»: клиент заплатил и не
 *                     получил — это долг, а не статистика. Такой клиент по исходу
 *                     «пробовал» (покупки нет), и строка несёт отдельную пометку.
 */
export const PANEL_CLIENT_SEGMENTS = [
  'all',
  'buyers',
  'tried',
  'lurkers',
  'unreachable',
  'stuck',
] as const;

export type PanelClientSegment = (typeof PANEL_CLIENT_SEGMENTS)[number];

/** Порядок списка. Живёт в адресе экрана (`?sort=`). */
export const PANEL_CLIENT_SORTS = ['newest', 'active', 'purchased_desc', 'orders_desc'] as const;

export type PanelClientSort = (typeof PANEL_CLIENT_SORTS)[number];

export type PanelClientListFilters = {
  segment?: PanelClientSegment;
  /** Имя, telegram_id, @username, email или цифры телефона. */
  query?: string;
  sort?: PanelClientSort;
  /** Окно по дате регистрации `[createdFrom, createdTo)`, ISO-строки. */
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
  offset?: number;
};

export type PanelClientListItem = {
  id: string;
  displayName: string | null;
  telegramId: string | null;
  telegramUsername: string | null;
  /** Флаг, не сам идентификатор сессии (см. заголовок модуля). */
  hasWebSession: boolean;
  hasEmail: boolean;
  hasPhone: boolean;
  createdAt: Date;
  /** Кто привёл (id) — сама ссылка на партнёра живёт в карточке. */
  referredById: string | null;
  ordersCount: number;
  purchasedCount: number;
  /** Сумма состоявшихся покупок, копейки. */
  purchasedRubKopecks: number;
  lastPaidAt: Date | null;
  lastOrderAt: Date | null;
  /**
   * Последний след клиента: живой запрос (кабинет, оформление, чат — пишет
   * антифрод-трек), заказ или сообщение боту — что позже. `null` — след
   * старше колонки `last_seen_ip_at` и без заказов и сообщений.
   */
  lastActivityAt: Date | null;
  /** Деньги приняты, заказ в «Ошибке» — клиент заплатил и не получил. */
  moneyStuck: boolean;
};

export type PanelClientListPage = {
  items: PanelClientListItem[];
  hasMore: boolean;
};

/** Счётчики сегментов — при ТЕХ ЖЕ поиске и периоде, что у списка. */
export type PanelClientSegmentCounts = Record<PanelClientSegment, number>;

/**
 * Потолок длины поискового запроса — тот же, что у заказов: строка любой
 * длины гоняла бы несколько ILIKE с ведущим `%` в процессе, принимающем деньги.
 */
const MAX_QUERY_LENGTH = 100;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Итоги по заказам клиента — один LATERAL на строку `users`. Считается в базе,
 * а не по срезу заказов: у клиента с сотней заказов срез молча занижал бы
 * сумму (та же причина, по которой карточка клиента считает итоги отдельным
 * запросом).
 */
const ORDER_TOTALS_LATERAL = sql`
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS orders_count,
           count(*) FILTER (WHERE o.status IN ${PURCHASED_STATUSES_SQL})::int AS purchased_count,
           COALESCE(SUM(o.amount_rub) FILTER (WHERE o.status IN ${PURCHASED_STATUSES_SQL}), 0)::bigint
             AS purchased_sum,
           MAX(o.paid_at) FILTER (WHERE o.status IN ${PURCHASED_STATUSES_SQL}) AS last_paid_at,
           MAX(o.created_at) AS last_order_at,
           bool_or(o.status = 'failed' AND EXISTS (
             SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded'
           )) AS money_stuck
    FROM orders o
    WHERE o.user_id = u.id
  ) t ON true
`;

/** Последнее сообщение САМОГО клиента боту — его, а не наши ответы. */
const LAST_MESSAGE_LATERAL = sql`
  LEFT JOIN LATERAL (
    SELECT MAX(m.created_at) AS last_message_at
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.id AND m.role = 'user'
    WHERE c.user_id = u.id
  ) msg ON true
`;

const LAST_ACTIVITY_SQL = sql`GREATEST(u.last_seen_ip_at, t.last_order_at, msg.last_message_at)`;

function segmentCondition(segment: PanelClientSegment): SQL {
  switch (segment) {
    case 'buyers':
      return sql`t.purchased_count > 0`;
    case 'tried':
      return sql`t.orders_count > 0 AND t.purchased_count = 0`;
    case 'lurkers':
      return sql`t.orders_count = 0`;
    case 'unreachable':
      return sql`u.telegram_id IS NULL`;
    case 'stuck':
      return sql`COALESCE(t.money_stuck, false)`;
    case 'all':
    default:
      return sql`true`;
  }
}

/**
 * Условия поиска и периода — общие для списка и для счётчиков сегментов:
 * чипы, посчитанные без поиска, при введённой почте показывали бы «Купили 12»
 * над списком из одной строки.
 */
function baseConditions(filters: PanelClientListFilters): SQL[] {
  const conditions: SQL[] = [];

  const query = filters.query?.trim().slice(0, MAX_QUERY_LENGTH);
  if (query) {
    const like = `%${escapeLikePattern(query)}%`;
    const alternatives: SQL[] = [
      sql`u.display_name ILIKE ${like}`,
      sql`u.telegram_id ILIKE ${like}`,
      sql`u.telegram_username ILIKE ${like}`,
      sql`u.email ILIKE ${like}`,
    ];
    // Телефон — по цифрам с обеих сторон, как в быстром поиске: в базе он
    // `+7999…`, а спрашивают с восьмёркой и скобками. Меньше четырёх цифр —
    // перебор половины базы, а не поиск.
    const digits = query.replace(/\D/g, '');
    if (digits.length >= 4) {
      alternatives.push(sql`regexp_replace(u.phone, '\\D', '', 'g') LIKE ${`%${digits}%`}`);
    }
    conditions.push(sql`(${sql.join(alternatives, sql` OR `)})`);
  }

  // Границы — ISO-строки, не `Date`: raw-`sql` Drizzle роняет postgres-js на
  // `Date`, а PGlite молчит (инцидент 2026-08-15).
  if (filters.createdFrom) conditions.push(sql`u.created_at >= ${filters.createdFrom}::timestamptz`);
  if (filters.createdTo) conditions.push(sql`u.created_at < ${filters.createdTo}::timestamptz`);

  return conditions;
}

function whereClause(conditions: SQL[]): SQL {
  return conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
}

/**
 * Порядок с тай-брейкером по id: без полного порядка Postgres волен отдать
 * строки с одинаковым ключом по-разному на соседних страницах, и клиент
 * показывается дважды либо не показывается никогда.
 */
function orderBy(sort: PanelClientSort): SQL {
  switch (sort) {
    case 'active':
      return sql`ORDER BY ${LAST_ACTIVITY_SQL} DESC NULLS LAST, u.created_at DESC, u.id DESC`;
    case 'purchased_desc':
      return sql`ORDER BY t.purchased_sum DESC, t.purchased_count DESC, u.created_at DESC, u.id DESC`;
    case 'orders_desc':
      return sql`ORDER BY t.orders_count DESC, u.created_at DESC, u.id DESC`;
    case 'newest':
    default:
      return sql`ORDER BY u.created_at DESC, u.id DESC`;
  }
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

export async function listClientsForPanel(
  db: DB,
  filters: PanelClientListFilters = {},
): Promise<PanelClientListPage> {
  const limit = clampPanelLimit(filters.limit);
  const offset = clampPanelOffset(filters.offset);
  const conditions = [...baseConditions(filters), segmentCondition(filters.segment ?? 'all')];

  const rows = await db.execute<{
    id: string;
    display_name: string | null;
    telegram_id: string | null;
    telegram_username: string | null;
    has_web_session: boolean;
    has_email: boolean;
    has_phone: boolean;
    created_at: string | Date;
    referred_by: string | null;
    orders_count: number | string;
    purchased_count: number | string;
    purchased_sum: number | string;
    last_paid_at: string | Date | null;
    last_order_at: string | Date | null;
    last_activity_at: string | Date | null;
    money_stuck: boolean | null;
  }>(sql`
    SELECT u.id, u.display_name, u.telegram_id, u.telegram_username,
           (u.web_session_id IS NOT NULL) AS has_web_session,
           (u.email IS NOT NULL) AS has_email,
           (u.phone IS NOT NULL) AS has_phone,
           u.created_at, u.referred_by,
           t.orders_count, t.purchased_count, t.purchased_sum, t.last_paid_at, t.last_order_at,
           ${LAST_ACTIVITY_SQL} AS last_activity_at,
           t.money_stuck
    FROM users u
    ${ORDER_TOTALS_LATERAL}
    ${LAST_MESSAGE_LATERAL}
    ${whereClause(conditions)}
    ${orderBy(filters.sort ?? 'newest')}
    LIMIT ${limit + 1} OFFSET ${offset}
  `);

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    displayName: r.display_name,
    telegramId: r.telegram_id,
    telegramUsername: r.telegram_username,
    hasWebSession: r.has_web_session,
    hasEmail: r.has_email,
    hasPhone: r.has_phone,
    createdAt: toDate(r.created_at) ?? new Date(0),
    referredById: r.referred_by,
    ordersCount: Number(r.orders_count ?? 0),
    purchasedCount: Number(r.purchased_count ?? 0),
    purchasedRubKopecks: Number(r.purchased_sum ?? 0),
    lastPaidAt: toDate(r.last_paid_at),
    lastOrderAt: toDate(r.last_order_at),
    lastActivityAt: toDate(r.last_activity_at),
    moneyStuck: r.money_stuck === true,
  }));

  return { items, hasMore };
}

/**
 * Сколько клиентов в каждом сегменте — одним запросом, при тех же поиске и
 * периоде, что у списка. Без потолка: это `count`, а не строки.
 */
export async function countClientSegmentsForPanel(
  db: DB,
  filters: Pick<PanelClientListFilters, 'query' | 'createdFrom' | 'createdTo'> = {},
): Promise<PanelClientSegmentCounts> {
  const rows = await db.execute<Record<PanelClientSegment, number | string>>(sql`
    SELECT count(*)::int AS "all",
           count(*) FILTER (WHERE ${segmentCondition('buyers')})::int AS buyers,
           count(*) FILTER (WHERE ${segmentCondition('tried')})::int AS tried,
           count(*) FILTER (WHERE ${segmentCondition('lurkers')})::int AS lurkers,
           count(*) FILTER (WHERE ${segmentCondition('unreachable')})::int AS unreachable,
           count(*) FILTER (WHERE ${segmentCondition('stuck')})::int AS stuck
    FROM users u
    ${ORDER_TOTALS_LATERAL}
    ${whereClause(baseConditions(filters))}
  `);
  const row = rows[0];
  const pick = (key: PanelClientSegment) => Number(row?.[key] ?? 0);
  return {
    all: pick('all'),
    buyers: pick('buyers'),
    tried: pick('tried'),
    lurkers: pick('lurkers'),
    unreachable: pick('unreachable'),
    stuck: pick('stuck'),
  };
}

// ─── Действия клиента (карточка) ──────────────────────────────────────────

export type PanelClientActivityEvent = {
  occurredAt: Date;
  /** Имя события из словаря аналитики (`@oplati/types`) — подпись даёт панель. */
  name: string;
  /** `event` — телеметрия, `milestone` — веха из денежных таблиц. */
  kind: string;
  channel: string;
  orderShortId: string | null;
  props: Record<string, unknown> | null;
};

export type PanelClientSupportSummary = {
  conversationsCount: number;
  /** Сообщений САМОГО клиента (не ответов бота и оператора). */
  clientMessagesCount: number;
  lastClientMessageAt: Date | null;
  /** Режим последнего telegram-разговора: кто сейчас отвечает клиенту. */
  lastMode: ConversationMode | null;
};

export type PanelClientVpn = {
  status: string;
  expireAt: Date;
  createdAt: Date;
};

export type PanelClientActivity = {
  /** Лента — новые сверху, потолок общий с панелью. */
  events: PanelClientActivityEvent[];
  /** За потолком остались ещё события — экран говорит об этом вслух. */
  hasMoreEvents: boolean;
  support: PanelClientSupportSummary;
  /** VPN-подписка Оплатишки; ссылка НЕ отдаётся (см. заголовок модуля). */
  vpn: PanelClientVpn | null;
};

/**
 * Что делал клиент — лента из вьюхи `analytics_timeline` (миграция 0029): та
 * же, что питает воронку раздела «Отчёты» и Metabase. Второго определения
 * «событие клиента» панель не заводит: телеметрия сайта и кабинета, денежные
 * вехи из `order_events`, привязка Telegram и выдача VPN приходят одной лентой.
 *
 * Фильтр по `user_id` вьюхи — по столбцу, который она вычисляет, поэтому
 * Postgres не сведёт запрос к индексу и пройдёт события целиком. На нынешнем
 * объёме (около одного заказа в день) это доли секунды; при росте — заменить
 * на прямой запрос к `analytics_events` по индексам telegram/сессии, сохранив
 * ту же форму строки.
 */
export async function getClientActivityForPanel(
  db: DB,
  userId: string,
  opts: { limit?: number } = {},
): Promise<PanelClientActivity> {
  const limit = clampPanelLimit(opts.limit);

  const [eventRows, supportRows, vpnRows] = await Promise.all([
    db.execute<{
      occurred_at: string | Date;
      name: string;
      kind: string;
      channel: string;
      order_ref: string | null;
      props: unknown;
    }>(sql`
      SELECT t.occurred_at, t.name, t.kind, t.channel, t.order_ref, t.props
      FROM analytics_timeline t
      WHERE t.user_id = ${userId}::uuid
        AND t.name IS NOT NULL
      ORDER BY t.occurred_at DESC, t.name DESC
      LIMIT ${limit + 1}
    `),
    db.execute<{
      conversations_count: number | string;
      client_messages_count: number | string;
      last_client_message_at: string | Date | null;
      last_mode: string | null;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM conversations c WHERE c.user_id = ${userId}::uuid)
          AS conversations_count,
        (SELECT count(*)::int
           FROM conversations c JOIN messages m ON m.conversation_id = c.id
          WHERE c.user_id = ${userId}::uuid AND m.role = 'user') AS client_messages_count,
        (SELECT MAX(m.created_at)
           FROM conversations c JOIN messages m ON m.conversation_id = c.id
          WHERE c.user_id = ${userId}::uuid AND m.role = 'user') AS last_client_message_at,
        (SELECT c.handoff_mode::text FROM conversations c
          WHERE c.user_id = ${userId}::uuid AND c.channel = 'telegram'
          ORDER BY c.updated_at DESC, c.id DESC LIMIT 1) AS last_mode
    `),
    db.execute<{ status: string; expire_at: string | Date; created_at: string | Date }>(sql`
      SELECT v.status, v.expire_at, v.created_at
      FROM vpn_subscriptions v
      WHERE v.user_id = ${userId}::uuid
      ORDER BY v.created_at DESC
      LIMIT 1
    `),
  ]);

  const hasMoreEvents = eventRows.length > limit;
  const events = eventRows.slice(0, limit).map((r) => ({
    occurredAt: toDate(r.occurred_at) ?? new Date(0),
    name: r.name,
    kind: r.kind,
    channel: r.channel,
    orderShortId: r.order_ref,
    props: parseProps(r.props),
  }));

  const support = supportRows[0];
  const vpn = vpnRows[0];

  return {
    events,
    hasMoreEvents,
    support: {
      conversationsCount: Number(support?.conversations_count ?? 0),
      clientMessagesCount: Number(support?.client_messages_count ?? 0),
      lastClientMessageAt: toDate(support?.last_client_message_at),
      lastMode: isConversationMode(support?.last_mode) ? support.last_mode : null,
    },
    vpn: vpn
      ? {
          status: vpn.status,
          expireAt: toDate(vpn.expire_at) ?? new Date(0),
          createdAt: toDate(vpn.created_at) ?? new Date(0),
        }
      : null,
  };
}

/**
 * jsonb приходит объектом и у postgres-js, и у PGlite. Всё, что не объект, —
 * не детали события: показываем событие без них, а не разбираем строку сами.
 */
function parseProps(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isConversationMode(value: string | null | undefined): value is ConversationMode {
  return value === 'idle' || value === 'ai' || value === 'operator';
}
