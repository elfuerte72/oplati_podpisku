import { z } from 'zod';

/**
 * Поведенческая аналитика — единственный источник правды о событиях.
 *
 * Отсюда берутся: типы для `track()`, allowlist имён на приёме, человеческие
 * подписи в Metabase (таблица `analytics_event_types` наполняется upsert'ом из
 * этого файла) и справочник для того, кто в код не смотрит. Дрейф между кодом и
 * подписями поэтому невозможен.
 *
 * ГЛАВНОЕ ПРАВИЛО РАЗДЕЛЕНИЯ. Здесь живут ТОЛЬКО наблюдения за поведением
 * (клики, открытия, отвалы) — то, чего в БД нет. Денежные вехи (заказ создан,
 * счёт выставлен, оплачено, карта выдана) НЕ дублируются: они уже пишутся в
 * `order_events` в одной транзакции с деньгами (инвариант 1), а телеметрия
 * пишется best-effort через `after()`. Две записи об одном факте неизбежно
 * разъедутся — и разъедутся в отчёте о выручке, где цена ошибки максимальная.
 * Вехи перечислены в `ANALYTICS_MILESTONES` и подмешиваются в отчёт вьюхой.
 *
 * ВТОРОЕ ПРАВИЛО. Имя события вечно: это факт прошлого, его смысл не меняется.
 * Новое поведение = новое имя, а не переопределение старого. Всё, что может
 * измениться (какая кнопка, какой сервис, какой шаг), живёт в `props`.
 */

// ─── Каналы ───────────────────────────────────────────────────────────────

export const ANALYTICS_CHANNELS = ['web', 'miniapp', 'bot'] as const;
export type AnalyticsChannel = (typeof ANALYTICS_CHANNELS)[number];

/**
 * `text`, а не `pgEnum`: добавление канала не должно требовать миграции
 * (`ALTER TYPE ... ADD VALUE` у нас отдельная головная боль — см. раздел
 * «Enum-расширения» в CLAUDE.md). Валидация — здесь, на границе.
 */
export const analyticsChannel = z.enum(ANALYTICS_CHANNELS);

/**
 * Кто записал событие. `client` приходит по HTTP из браузера и доверия не
 * заслуживает; `server` пишется нашим кодом. Эндпоинт приёма отклоняет любое
 * событие, объявленное серверным — иначе конверсию можно нарисовать curl'ом.
 */
export const ANALYTICS_ORIGINS = ['client', 'server'] as const;
export type AnalyticsOrigin = (typeof ANALYTICS_ORIGINS)[number];
export const analyticsOrigin = z.enum(ANALYTICS_ORIGINS);

// ─── Реестр собственных событий ───────────────────────────────────────────

type AnalyticsEventSpec = {
  /** Человеческое название — подпись в отчёте. */
  readonly title: string;
  /** Что это значит. Обязательно: отчёт читает не только автор кода. */
  readonly description: string;
  /** Где происходит. */
  readonly channel: AnalyticsChannel;
  /** Кто пишет. Серверные события эндпоинт приёма не принимает. */
  readonly origin: AnalyticsOrigin;
  /** Ключи props, осмысленные для этого события (документация, не валидация). */
  readonly props: readonly string[];
};

export const ANALYTICS_EVENTS = {
  // ── Сайт ────────────────────────────────────────────────────────────────
  page_view: {
    title: 'Зашёл на сайт',
    description:
      'Открыл страницу сайта. Видно, откуда пришёл — реклама, поиск или ссылка из бота — и с какого устройства.',
    channel: 'web',
    origin: 'client',
    props: ['path', 'src', 'utm_source', 'utm_medium', 'utm_campaign', 'referrer_host'],
  },
  how_it_works_open: {
    title: 'Открыл «Как это работает»',
    description:
      'Развернул объяснение из трёх шагов. По props видно, досмотрел до конца или бросил на первом.',
    channel: 'web',
    origin: 'client',
    props: ['step', 'count', 'completed'],
  },
  catalog_open: {
    title: 'Открыл список сервисов',
    description: 'Нажал «Выбрать сервис» и увидел витрину.',
    channel: 'web',
    origin: 'client',
    props: ['items', 'source'],
  },
  service_click: {
    title: 'Выбрал сервис',
    description:
      'Ткнул в конкретную карточку каталога. Видно, какие сервисы смотрят и у скольких из них есть требование VPN.',
    channel: 'web',
    origin: 'client',
    props: ['slug', 'position', 'requires_vpn'],
  },
  plan_select: {
    title: 'Выбрал тариф',
    description: 'Определился с тарифом и суммой в долларах — последний шаг перед оформлением.',
    channel: 'web',
    origin: 'client',
    props: ['slug', 'plan', 'amount_usd_cents'],
  },
  price_breakdown_open: {
    title: 'Проверил, из чего сумма',
    description:
      'Раскрыл расчёт цены (курс, комиссия, выпуск карты). Массово — значит цена вызывает вопросы.',
    channel: 'web',
    origin: 'client',
    props: ['order_ref', 'surface'],
  },
  telegram_link_click: {
    title: 'Пошёл подключать Telegram',
    description:
      'Нажал кнопку привязки. Без Telegram оплатить нельзя — кто не дошёл дальше, потерян на нашем же гейте.',
    channel: 'web',
    origin: 'client',
    props: ['gate', 'source'],
  },

  // ── Mini App ────────────────────────────────────────────────────────────
  cabinet_open: {
    title: 'Открыл личный кабинет',
    description: 'Запустил Mini App — из меню бота или по прямой ссылке.',
    channel: 'miniapp',
    origin: 'client',
    props: ['entry'],
  },
  card_details_view: {
    title: 'Посмотрел реквизиты карты',
    description: 'Разовый показ реквизитов в кабинете (скрываются через минуту).',
    channel: 'miniapp',
    origin: 'client',
    // Ни одного поля про карту: даже `card_last4` не заводим — ключ с таким
    // именем приглашает вписать туда PAN целиком, а пользы от него нет
    // (карта у клиента одна, она видна в кабинете).
    props: [],
  },
  service_site_click: {
    title: 'Ушёл оплачивать на сайт сервиса',
    description:
      'Перешёл на сайт подписки с нашей картой. Дальше он вне нашей видимости — до отметки об успехе или жалобы.',
    channel: 'miniapp',
    origin: 'client',
    props: ['slug', 'target'],
  },

  // ── Общие для web и Mini App ────────────────────────────────────────────
  pay_link_click: {
    title: 'Нажал «Оплатить»',
    description:
      'Ушёл на страницу платёжного сервиса. ВНИМАНИЕ: в боте это событие не пишется — Telegram не сообщает о нажатии url-кнопки.',
    channel: 'web',
    origin: 'client',
    props: ['provider', 'amount_kopecks', 'order_ref', 'surface'],
  },
  referral_link_share: {
    title: 'Поделился реф-ссылкой',
    description: 'Скопировал или отправил партнёрскую ссылку из кабинета.',
    channel: 'miniapp',
    origin: 'client',
    props: ['action', 'surface'],
  },

  // ── Бот (только сервер: клиент таких событий писать не может) ───────────
  bot_start: {
    title: 'Открыл бота',
    description: 'Команда /start. По props видно, с чем пришёл: привязка, реферальная ссылка, кабинет или просто так.',
    channel: 'bot',
    origin: 'server',
    props: ['payload_kind', 'source'],
  },
  bot_menu_click: {
    title: 'Нажал кнопку в боте',
    description:
      'Нажатие inline-кнопки. Какая именно — в props.button. ВНИМАНИЕ: url-кнопки (Сайт, канал, сторы, оплата) Telegram не отслеживает, сюда попадают только callback-кнопки.',
    channel: 'bot',
    origin: 'server',
    props: ['button', 'slug'],
  },
  bot_text_ignored: {
    title: 'Написал в бота то, чего бот при выключенном AI не умеет',
    description:
      'Клиент отправил текст или медиа при выключенном BOT_AI_ENABLED — по делу бот не отвечает. С тикета 09 в ответ уходит подсказка с кнопкой «Поддержка»: props.hinted=true означает, что она реально отправлена, false — что её погасил дедуп (альбом фото, серия сообщений подряд). Имя события прежнее намеренно: оно меряет тот же спрос, что и раньше, и история сравнима.',
    channel: 'bot',
    origin: 'server',
    props: ['kind', 'len', 'hinted'],
  },
  support_requested: {
    title: 'Обратился в поддержку',
    description: 'Написал через /support или кнопку «Поддержка» — обращение ушло оператору.',
    channel: 'bot',
    origin: 'server',
    props: ['surface', 'stage'],
  },
  support_session_started: {
    title: 'Открыл сессию помощника поддержки',
    description:
      'Клиент вошёл в поддержку кнопкой, командой /support или ссылкой — открылась сессия помощника. props.surface: button | command | deeplink.',
    channel: 'bot',
    origin: 'server',
    props: ['surface'],
  },
  support_ai_reply: {
    title: 'Помощник ответил клиенту',
    description:
      'Один ход помощника поддержки. props.count — сколько инструментов он вызвал; props.gate=guarded означает, что ответ погасил выходной фильтр и клиент увидел нейтральную фразу вместо него.',
    channel: 'bot',
    origin: 'server',
    props: ['count', 'gate'],
  },
  support_escalated: {
    title: 'Разговор передан оператору',
    description:
      'Помощник передал разговор человеку. props.stage — триггер: hard (жёсткое слово), model (решение модели), ai_unavailable (авария помощника), guard (выходной фильтр).',
    channel: 'bot',
    origin: 'server',
    props: ['stage'],
  },
  support_returned_to_ai: {
    title: 'Оператор вернул разговор помощнику',
    description: 'Оператор нажал «Вернуть помощнику» в панели — рутину снова ведёт бот.',
    channel: 'bot',
    origin: 'server',
    props: [],
  },
  support_session_closed: {
    title: 'Разговор поддержки завершён',
    description:
      'props.stage — кем и почему: client (кнопка «Завершить»), operator (закрыл оператор), ttl (30 минут молчания), auto (крон закрыл через сутки после ответа оператора), start (клиент ушёл в /start), cap (исчерпан суточный лимит ходов).',
    channel: 'bot',
    origin: 'server',
    props: ['stage'],
  },
} as const satisfies Record<string, AnalyticsEventSpec>;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENTS;

export const ANALYTICS_EVENT_NAMES = Object.keys(ANALYTICS_EVENTS) as [
  AnalyticsEventName,
  ...AnalyticsEventName[],
];

export const analyticsEventName = z.enum(ANALYTICS_EVENT_NAMES);

/** События, которые разрешено принимать по HTTP из браузера. */
export const CLIENT_EVENT_NAMES = ANALYTICS_EVENT_NAMES.filter(
  (name) => ANALYTICS_EVENTS[name].origin === 'client',
);

export function isClientTrackable(name: AnalyticsEventName): boolean {
  return ANALYTICS_EVENTS[name].origin === 'client';
}

// ─── Вехи из существующих таблиц (НЕ дублируются телеметрией) ─────────────

type AnalyticsMilestoneSpec = {
  readonly title: string;
  readonly description: string;
  /** Откуда берётся в отчёте — человекочитаемо, для рунбука и вьюхи. */
  readonly source: string;
};

/**
 * Эти факты уже записаны в БД атомарно с деньгами. Вью `analytics_timeline`
 * подмешивает их к телеметрии, чтобы путь клиента читался одной лентой.
 * Приятный побочный эффект: отчёты показывают историю за всё прошлое, а не
 * с момента включения аналитики.
 */
export const ANALYTICS_MILESTONES = {
  order_proposed: {
    title: 'Оформил заказ',
    description: 'Мы посчитали рублёвую цену и зафиксировали курс на два часа.',
    source: "order_events.event_type = 'order_created'",
  },
  telegram_linked: {
    title: 'Подключил Telegram',
    description: 'Дошёл до бота и привязал аккаунт. Наш самый крупный гейт: без него оплата недоступна.',
    source: 'link_tokens.used_at',
  },
  invoice_sent: {
    title: 'Получил счёт',
    description: 'Счёт выставлен у платёжного шлюза, ссылка отправлена клиенту.',
    source: "order_events.event_type = 'payment_invoice_created'",
  },
  payment_paid: {
    title: 'Оплатил',
    description: 'Деньги приняты. Пишет вебхук платёжного шлюза, не клиент.',
    source: "order_events.event_type = 'payment_succeeded'",
  },
  card_issued: {
    title: 'Получил карту',
    description: 'Реквизиты выпущены и доставлены клиенту в Telegram.',
    source: "order_events.event_type = 'fulfillment_completed'",
  },
  subscription_paid: {
    title: 'Подтвердил, что подписка работает',
    description: 'Довёл до конца: подписка оплачена нашей картой на сайте сервиса.',
    source: "order_events.event_type = 'subscription_activated'",
  },
  handoff_requested: {
    title: 'Позвал оператора из продажного диалога',
    description:
      'AI-агент продаж вызвал `request_human` по заказу. С 2026-08-27 это ведёт в общий механизм эскалации поддержки (переход разговора к оператору + уведомление персонала); строка в `order_events` — аудит-след по заказу. Телеметрией не дублируется.',
    source: "order_events.event_type = 'handoff_requested'",
  },
  payment_issue: {
    title: 'Пожаловался на оплату',
    description: 'Карта не прошла на сайте сервиса — обращение ушло оператору.',
    source: "order_events.event_type = 'payment_issue_reported'",
  },
  order_expired: {
    title: 'Заказ протух',
    description: 'Истёк срок фиксации цены или счёта — клиент не оплатил вовремя.',
    source: "order_events.event_type = 'order_expired'",
  },
  vpn_link_issued: {
    title: 'Получил ссылку на VPN',
    description: 'Выдана персональная подписка Remnawave по кнопке «VPN» в меню бота.',
    source: 'vpn_subscriptions.created_at',
  },
} as const satisfies Record<string, AnalyticsMilestoneSpec>;

export type AnalyticsMilestoneName = keyof typeof ANALYTICS_MILESTONES;

// ─── Воронка ──────────────────────────────────────────────────────────────

/**
 * Порядок шагов главной воронки. Четыре из семи читаются из уже накопленных
 * данных, поэтому первые отчёты покажут историю за всё прошлое.
 *
 * `telegram_linked` шагом воронки НЕ является, хотя гейт крупный: привязка
 * нужна только пришедшим с сайта, а кто сразу написал боту — минует её.
 * Проверено на живых данных 2026-07-30: как шаг он давал 7 человек против 11
 * на следующем шаге, то есть воронка «сужалась» вверх. Смотреть его надо
 * отдельным вопросом: telegram_link_click против вехи telegram_linked.
 */
export const ANALYTICS_FUNNEL = [
  { step: 1, name: 'page_view', from: 'events' },
  { step: 2, name: 'catalog_open', from: 'events' },
  { step: 3, name: 'service_click', from: 'events' },
  { step: 4, name: 'order_proposed', from: 'milestones' },
  { step: 5, name: 'invoice_sent', from: 'milestones' },
  { step: 6, name: 'payment_paid', from: 'milestones' },
  { step: 7, name: 'subscription_paid', from: 'milestones' },
] as const satisfies readonly {
  step: number;
  name: AnalyticsEventName | AnalyticsMilestoneName;
  from: 'events' | 'milestones';
}[];

// ─── props: allowlist ─────────────────────────────────────────────────────

/**
 * Разрешённые ключи props — общий список на все события. Неизвестные ключи
 * ОТБРАСЫВАЮТСЯ молча, а не роняют событие: закэшированный старый клиент не
 * должен терять данные из-за ключа, который мы переименовали. PII сюда
 * попасть не может по построению — свободного текста в списке нет.
 */
export const ANALYTICS_PROP_KEYS = [
  'path',
  'src',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'referrer_host',
  'step',
  'completed',
  'items',
  'source',
  'surface',
  'slug',
  'position',
  'requires_vpn',
  'plan',
  'amount_usd_cents',
  'amount_kopecks',
  'order_ref',
  'provider',
  'entry',
  'target',
  'action',
  'button',
  'payload_kind',
  'kind',
  'len',
  // Ушла ли клиенту подсказка «бот не молчит» (тикет 09) или её погасил дедуп.
  'hinted',
  'gate',
  'stage',
  'count',
] as const;

export type AnalyticsPropKey = (typeof ANALYTICS_PROP_KEYS)[number];

const PROP_KEY_SET: ReadonlySet<string> = new Set(ANALYTICS_PROP_KEYS);

/** Потолок на число ключей — защита от раздувания jsonb мусором. */
export const ANALYTICS_MAX_PROPS = 16;
/** Потолок длины строкового значения. */
export const ANALYTICS_MAX_PROP_LENGTH = 200;

/**
 * Последовательности из 12+ цифр (возможный PAN) вырезаются из строковых
 * значений. Allowlist ограничивает КЛЮЧИ, но не содержимое: под разрешённым
 * ключом можно прислать что угодно. Тот же приём уже применяется к комментарию
 * клиента перед отправкой оператору (`buildPaymentIssueOperatorMessage`).
 */
const PAN_LIKE_RE = /\d[\d\s-]{10,}\d/g;

export type AnalyticsProps = Partial<Record<AnalyticsPropKey, string | number | boolean>>;

/**
 * Фильтрует props: оставляет известные ключи со скалярными значениями,
 * обрезает строки, ограничивает количество. Никогда не бросает.
 */
export function sanitizeAnalyticsProps(raw: unknown): AnalyticsProps {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const out: Record<string, string | number | boolean> = {};
  let taken = 0;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (taken >= ANALYTICS_MAX_PROPS) break;
    if (!PROP_KEY_SET.has(key)) continue;

    if (typeof value === 'string') {
      out[key] = value.replace(PAN_LIKE_RE, '[REDACTED]').slice(0, ANALYTICS_MAX_PROP_LENGTH);
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else {
      continue;
    }
    taken += 1;
  }

  return out as AnalyticsProps;
}

// ─── Контракт приёма ──────────────────────────────────────────────────────

/**
 * Максимум событий в одном батче с клиента.
 *
 * Вместе с бакетом rate-limit это и есть потолок записи для анонима: 10 событий
 * × 20 запросов/мин = 200 строк в минуту с одного IP. Живому клиенту столько не
 * нужно (весь путь до оплаты — десяток событий), а раздувание общего с боевой
 * БД тома перестаёт быть дешёвым.
 */
export const ANALYTICS_MAX_BATCH = 10;

/**
 * Расхождение часов клиента, после которого `occurred_at` не заслуживает
 * доверия и подменяется серверным временем получения. Часы на устройствах
 * врут и подделываются, а сбитая дата ломает сортировку всего пути.
 */
export const ANALYTICS_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const analyticsIngestEventSchema = z.object({
  /** Клиентский ключ идемпотентности: ретрай и двойной клик не удваивают воронку. */
  eventKey: z.string().min(8).max(64),
  name: analyticsEventName,
  channel: analyticsChannel,
  /** Время на источнике (ISO). Санитизируется на приёме. */
  occurredAt: z.string().datetime({ offset: true }),
  props: z.unknown().optional().transform(sanitizeAnalyticsProps),
  /**
   * Номер заказа (`ORD-XXXXX`), если событие про заказ. Именно человеческий
   * номер, а не UUID: он короткий, он же показан клиенту и он же лежит в
   * `orders.short_id`. Формат проверяется явно — иначе UUID (36 символов)
   * молча отбивал бы весь батч как invalid_body.
   */
  orderRef: z
    .string()
    .regex(/^ORD-[A-Z0-9]{1,24}$/, 'orderRef должен быть номером вида ORD-XXXXX')
    .optional(),
});
export type AnalyticsIngestEvent = z.infer<typeof analyticsIngestEventSchema>;

export const analyticsIngestBatchSchema = z.object({
  events: z.array(analyticsIngestEventSchema).min(1).max(ANALYTICS_MAX_BATCH),
});
export type AnalyticsIngestBatch = z.infer<typeof analyticsIngestBatchSchema>;

/**
 * Приводит время события к доверенному: будущее и слишком старые часы клиента
 * заменяются моментом получения на сервере.
 */
export function resolveOccurredAt(occurredAtIso: string, receivedAt: Date): Date {
  const parsed = new Date(occurredAtIso);
  if (Number.isNaN(parsed.getTime())) return receivedAt;
  const skew = Math.abs(receivedAt.getTime() - parsed.getTime());
  if (parsed.getTime() > receivedAt.getTime()) return receivedAt;
  if (skew > ANALYTICS_MAX_CLOCK_SKEW_MS) return receivedAt;
  return parsed;
}

/** Строки словаря для upsert'а в `analytics_event_types`. */
export function analyticsDictionaryRows(): {
  name: string;
  title: string;
  description: string;
  channel: string;
  origin: string;
  funnelStep: number | null;
  kind: 'event' | 'milestone';
}[] {
  const funnelStepOf = (name: string): number | null =>
    ANALYTICS_FUNNEL.find((s) => s.name === name)?.step ?? null;

  const events = ANALYTICS_EVENT_NAMES.map((name) => {
    const spec = ANALYTICS_EVENTS[name];
    return {
      name,
      title: spec.title,
      description: spec.description,
      channel: spec.channel as string,
      origin: spec.origin as string,
      funnelStep: funnelStepOf(name),
      kind: 'event' as const,
    };
  });

  const milestones = (Object.keys(ANALYTICS_MILESTONES) as AnalyticsMilestoneName[]).map((name) => {
    const spec = ANALYTICS_MILESTONES[name];
    return {
      name,
      title: spec.title,
      description: spec.description,
      channel: 'derived',
      origin: 'server',
      funnelStep: funnelStepOf(name),
      kind: 'milestone' as const,
    };
  });

  return [...events, ...milestones];
}
