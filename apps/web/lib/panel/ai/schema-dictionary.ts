import { PURCHASED_ORDER_STATUSES, allowedTransitions, orderStatus } from '@oplati/types';

/**
 * Словарь схемы для системного промпта AI-аналитика (спека admin-panel-v2,
 * ветка B, тикет 06): ровно те таблицы, вьюхи и колонки, что выданы роли
 * `panel_ai_ro` (`packages/db/scripts/panel-ai-role.sql`).
 *
 * Словарь и грант — зеркало (инвариант 10), поэтому их сверяет тест
 * `schema-dictionary.test.ts`: таблица из гранта без описания здесь и описание
 * без гранта роняют тест, а не всплывают ответом модели «permission denied».
 * Колонки таблиц сверяются со `schema.ts` тем же тестом — выдуманной колонки в
 * словаре быть не может.
 *
 * Недоступное названо явно (`PANEL_AI_UNAVAILABLE`): модель, знающая, что email
 * у роли нет, не тратит ход на попытку и честно отвечает «данные недоступны».
 */

export type SchemaColumn = { name: string; meaning: string };

export type SchemaEntry = {
  table: string;
  kind: 'table' | 'view';
  purpose: string;
  columns: readonly SchemaColumn[];
  notes?: readonly string[];
};

const money = (unit: string) => `${unit}; integer, дробей нет`;

export const PANEL_AI_SCHEMA: readonly SchemaEntry[] = [
  {
    table: 'orders',
    kind: 'table',
    purpose: 'Заказы клиентов — центральная таблица.',
    columns: [
      { name: 'id', meaning: 'uuid заказа' },
      { name: 'short_id', meaning: 'номер заказа вида ORD-7KX42 — так его называют люди' },
      { name: 'user_id', meaning: 'клиент (users.id)' },
      { name: 'conversation_id', meaning: 'разговор, из которого создан заказ (может быть NULL)' },
      { name: 'service_id', meaning: 'сервис из каталога (services.id); NULL — заказ вне каталога' },
      { name: 'custom_service_description', meaning: 'свободное описание заказа вне каталога' },
      { name: 'status', meaning: 'текущий статус (см. статус-машину ниже)' },
      { name: 'amount_rub', meaning: money('сумма к оплате в КОПЕЙКАХ') },
      { name: 'original_amount', meaning: money('цена сервиса в минимальных единицах валюты (для USD — центы)') },
      { name: 'original_currency', meaning: 'валюта original_amount, обычно USD' },
      { name: 'requires_kyc', meaning: 'нужны ли документы' },
      { name: 'kyc_completed_at', meaning: 'когда документы приняты' },
      { name: 'assigned_operator_id', meaning: 'сотрудник (staff.id), если заказ вели вручную' },
      { name: 'supervisor_id', meaning: 'не используется' },
      { name: 'parameters', meaning: 'jsonb параметров заказа (тариф и т.п.)' },
      { name: 'usdt_rub_rate_kopecks', meaning: 'курс USDT→RUB × 10000 на момент фиксации' },
      { name: 'rate_fixed_at', meaning: 'когда зафиксирован курс' },
      { name: 'expires_at', meaning: 'срок фиксации цены / счёта' },
      { name: 'commission_percent', meaning: 'снимок процента комиссии (30 = 30%)' },
      { name: 'card_issue_fee_kopecks', meaning: 'надбавка за выпуск карты, копейки, уже внутри amount_rub' },
      { name: 'card_id', meaning: 'выпущенная карта (cards.id)' },
      { name: 'created_at', meaning: 'когда создан' },
      { name: 'paid_at', meaning: 'когда оплачен (поле заказа; точное время входа в статус — из order_events)' },
      { name: 'fulfilled_at', meaning: 'когда выдана карта' },
      { name: 'cancelled_at', meaning: 'когда отменён' },
      { name: 'refunded_at', meaning: 'когда возвращены деньги' },
    ],
    notes: [
      'Покупка состоялась, если status IN (' +
        PURCHASED_ORDER_STATUSES.map((s) => `'${s}'`).join(', ') +
        ') — по этому списку считается выручка и топы.',
      'Время ВХОДА заказа в статус — из order_events (to_status, created_at), не из полей заказа: при ручной выдаче поля врут.',
    ],
  },
  {
    table: 'order_events',
    kind: 'table',
    purpose: 'Append-only журнал событий заказа: каждый переход статуса и денежная веха.',
    columns: [
      { name: 'id', meaning: 'uuid события' },
      { name: 'order_id', meaning: 'заказ' },
      { name: 'actor_type', meaning: 'кто действовал: user / operator / system / ai / payment_provider' },
      { name: 'actor_id', meaning: 'users.id или staff.id (без FK)' },
      {
        name: 'event_type',
        meaning:
          'тип: order_created, status_changed, payment_invoice_created, payment_succeeded, payment_amount_mismatch, payment_cancelled, payment_review_entered, payment_review_client_notified, payment_blocked_capacity, payment_reminder_sent, payment_reminder_failed, fulfillment_started, fulfillment_completed, fulfillment_failed, issue_card_failed, card_issued, topup_pending, manual_fulfillment_started, manual_fulfillment_completed, subscription_activated, payment_issue_reported, order_expired, renewal_reminder_sent, user_cancelled, handoff_requested, note',
      },
      { name: 'from_status', meaning: 'статус до перехода (у переходов)' },
      { name: 'to_status', meaning: 'статус после перехода (у переходов)' },
      { name: 'payload', meaning: 'jsonb деталей события' },
      { name: 'created_at', meaning: 'когда произошло' },
    ],
    notes: [
      'Момент входа в статус X: max(created_at) WHERE to_status = X по заказу.',
      '«Застрял в статусе дольше N»: заказ в статусе X сейчас И время входа в X старше N.',
    ],
  },
  {
    table: 'payments',
    kind: 'table',
    purpose: 'Счета у платёжных шлюзов (Freekassa, Love&Pay) и их исход.',
    columns: [
      { name: 'id', meaning: 'uuid платежа' },
      { name: 'order_id', meaning: 'заказ' },
      { name: 'provider', meaning: 'шлюз: freekassa | loveandpay (прочие исторические)' },
      { name: 'provider_ref', meaning: 'идентификатор счёта у шлюза' },
      { name: 'provider_invoice_number', meaning: 'человекочитаемый номер счёта у шлюза' },
      { name: 'amount_rub', meaning: money('сумма счёта в КОПЕЙКАХ') },
      { name: 'status', meaning: 'pending | succeeded | failed | refunded' },
      { name: 'last_provider_status', meaning: 'последний код статуса Freekassa: 0 новый, 1 оплачен, 6 возврат, 7 холд антифрода, 8 ошибка, 9 отменён' },
      { name: 'last_provider_status_at', meaning: 'когда код менялся' },
      { name: 'recovered_via_polling', meaning: 'успех замечен опросом, а не вебхуком' },
      { name: 'expires_at', meaning: 'срок счёта' },
      { name: 'webhook_received_at', meaning: 'когда пришёл вебхук' },
      { name: 'created_at', meaning: 'когда выставлен' },
      { name: 'completed_at', meaning: 'когда стал succeeded или failed — время получения денег для выручки' },
    ],
    notes: [
      "Выручка за период: sum(amount_rub) WHERE status = 'succeeded' AND completed_at в окне.",
      'Колонка raw_payload роли НЕ выдана.',
    ],
  },
  {
    table: 'services',
    kind: 'table',
    purpose: 'Каталог сервисов (подписок).',
    columns: [
      { name: 'id', meaning: 'uuid' },
      { name: 'slug', meaning: 'машинное имя (netflix, chatgpt-plus)' },
      { name: 'name', meaning: 'название' },
      { name: 'description', meaning: 'описание' },
      { name: 'category', meaning: 'категория' },
      { name: 'requires_kyc', meaning: 'нужны ли документы' },
      { name: 'pricing_policy', meaning: 'jsonb тарифов' },
      { name: 'payment_instructions', meaning: 'jsonb правил оплаты на сайте сервиса' },
      { name: 'is_active', meaning: 'показывается ли в витрине' },
      { name: 'created_at', meaning: 'когда добавлен' },
    ],
  },
  {
    table: 'users',
    kind: 'table',
    purpose: 'Клиенты. Роли выданы ТОЛЬКО служебные колонки — контактов здесь нет.',
    columns: [
      { name: 'id', meaning: 'uuid клиента' },
      { name: 'language', meaning: 'язык' },
      { name: 'created_at', meaning: 'первый контакт' },
      { name: 'updated_at', meaning: 'последнее изменение' },
      { name: 'referred_by', meaning: 'кто привёл (users.id партнёра)' },
      { name: 'referral_code', meaning: 'партнёрский код клиента' },
      { name: 'referred_by_set_at', meaning: 'когда закреплён реферер' },
    ],
    notes: [
      'telegram_id клиента доступен через вьюху analytics_timeline (колонка telegram_id) или vpn_subscriptions.telegram_id.',
      'email, телефон, имя, IP, web_session_id роли НЕ выданы — запрос к ним вернёт permission denied.',
    ],
  },
  {
    table: 'cards',
    kind: 'table',
    purpose: 'Виртуальные карты, выпущенные клиентам.',
    columns: [
      { name: 'id', meaning: 'uuid карты' },
      { name: 'user_id', meaning: 'клиент' },
      { name: 'provider', meaning: 'эмитент (paypace)' },
      { name: 'provider_card_id', meaning: 'id карты у эмитента' },
      { name: 'pan_masked', meaning: 'маска номера — полного номера в базе нет' },
      { name: 'status', meaning: 'active | idle | recycled' },
      { name: 'balance_usd_cents', meaning: money('баланс в центах USD') },
      { name: 'last_used_at', meaning: 'последнее использование' },
      { name: 'recycled_at', meaning: 'когда закрыта' },
      { name: 'created_at', meaning: 'когда выпущена' },
    ],
  },
  {
    table: 'conversations',
    kind: 'table',
    purpose: 'Разговоры клиентов с ботом/поддержкой (без текста сообщений).',
    columns: [
      { name: 'id', meaning: 'uuid' },
      { name: 'user_id', meaning: 'клиент' },
      { name: 'channel', meaning: 'telegram | web' },
      { name: 'handoff_mode', meaning: 'кто отвечает: idle | ai | operator' },
      { name: 'mode_expires_at', meaning: 'когда режим сам вернётся в idle; NULL в operator — ждём человека' },
      { name: 'assigned_operator_id', meaning: 'сотрудник (staff.id)' },
      { name: 'telegram_topic_id', meaning: 'не используется' },
      { name: 'created_at', meaning: 'создан' },
      { name: 'updated_at', meaning: 'обновлён' },
    ],
    notes: ['Тексты сообщений (таблица messages) роли НЕ выданы.'],
  },
  {
    table: 'staff',
    kind: 'table',
    purpose: 'Персонал панели — только служебные колонки.',
    columns: [
      { name: 'id', meaning: 'uuid сотрудника (actor_id в order_events, assigned_operator_id)' },
      { name: 'display_name', meaning: 'имя' },
      { name: 'role', meaning: 'admin | operator | supervisor' },
      { name: 'is_active', meaning: 'доступ включён' },
      { name: 'last_login_at', meaning: 'последний вход' },
      { name: 'created_at', meaning: 'заведён' },
    ],
  },
  {
    table: 'referral_partners',
    kind: 'table',
    purpose: 'Профили партнёров реферальной программы.',
    columns: [
      { name: 'user_id', meaning: 'партнёр (users.id)' },
      { name: 'current_circle', meaning: 'статус партнёра (в UI — «статус»)' },
      { name: 'locked_rate_l1_bps', meaning: 'зафиксированная ставка в базисных пунктах (100 bps = 1%) — единственный источник ставки' },
      { name: 'boost_until', meaning: 'до какого времени действует буст' },
      { name: 'boost_rate_bps', meaning: 'ставка буста' },
      { name: 'team_multiplier', meaning: 'множитель команды' },
      { name: 'suspended', meaning: 'заблокирован антифродом' },
      { name: 'created_at', meaning: 'создан' },
      { name: 'updated_at', meaning: 'обновлён' },
    ],
  },
  {
    table: 'referral_accruals',
    kind: 'table',
    purpose: 'Append-only ledger реферальных начислений.',
    columns: [
      { name: 'id', meaning: 'uuid' },
      { name: 'beneficiary_user_id', meaning: 'кому начислено' },
      { name: 'source_user_id', meaning: 'чей заказ' },
      { name: 'order_id', meaning: 'заказ' },
      { name: 'payment_id', meaning: 'платёж' },
      { name: 'level', meaning: 'уровень (1)' },
      { name: 'kind', meaning: 'вид начисления' },
      { name: 'rate_bps', meaning: 'ставка в базисных пунктах' },
      { name: 'amount_usd_cents', meaning: money('сумма в центах USD') },
      { name: 'status', meaning: 'accrued | reversed и т.п.; reversed — компенсирующая строка' },
      { name: 'created_at', meaning: 'создано' },
    ],
  },
  {
    table: 'referral_payouts',
    kind: 'table',
    purpose: 'Заявки партнёров на выплату (реквизиты роли не выданы).',
    columns: [
      { name: 'id', meaning: 'uuid' },
      { name: 'user_id', meaning: 'партнёр' },
      { name: 'amount_usd_cents', meaning: money('сумма в центах USD') },
      { name: 'status', meaning: 'requested | processing | paid | rejected' },
      { name: 'method', meaning: 'способ выплаты' },
      { name: 'fee_usd_cents', meaning: money('комиссия в центах USD') },
      { name: 'requested_at', meaning: 'подана' },
      { name: 'settled_at', meaning: 'закрыта' },
    ],
  },
  {
    table: 'referral_monthly_stats',
    kind: 'table',
    purpose: 'Месячный роллап прогрессии партнёров.',
    columns: [
      { name: 'user_id', meaning: 'партнёр' },
      { name: 'month', meaning: 'месяц (дата первого дня)' },
      { name: 'network_turnover_usd_cents', meaning: money('оборот сети в центах USD') },
      { name: 'new_active_referrals', meaning: 'новых активных рефералов' },
      { name: 'active_l2', meaning: 'историческое поле второго уровня' },
      { name: 'plan_met', meaning: 'план выполнен' },
      { name: 'consecutive_met_months', meaning: 'месяцев подряд с планом' },
      { name: 'computed_at', meaning: 'когда посчитан' },
    ],
  },
  {
    table: 'vpn_subscriptions',
    kind: 'table',
    purpose: 'Выданные VPN-подписки (ссылка подписки роли не выдана).',
    columns: [
      { name: 'id', meaning: 'uuid' },
      { name: 'user_id', meaning: 'клиент' },
      { name: 'telegram_id', meaning: 'telegram_id клиента' },
      { name: 'remnawave_uuid', meaning: 'uuid пользователя в панели VPN' },
      { name: 'status', meaning: 'статус' },
      { name: 'expire_at', meaning: 'до какого времени действует' },
      { name: 'created_at', meaning: 'выдана' },
      { name: 'updated_at', meaning: 'обновлена' },
    ],
  },
  {
    table: 'ai_usage_daily',
    kind: 'table',
    purpose: 'Дневной расход токенов клиентского AI (одна строка на день).',
    columns: [
      { name: 'day', meaning: 'день' },
      { name: 'requests', meaning: 'запросов' },
      { name: 'input_tokens', meaning: 'входных токенов' },
      { name: 'output_tokens', meaning: 'выходных токенов' },
      { name: 'cache_read_tokens', meaning: 'прочитано из кэша' },
      { name: 'cache_write_tokens', meaning: 'записано в кэш' },
      { name: 'web_search_requests', meaning: 'веб-поисков' },
      { name: 'updated_at', meaning: 'обновлено' },
    ],
  },
  {
    table: 'funnel_sends',
    kind: 'table',
    purpose: 'Отправленные сообщения воронки обратной связи (журнал и claim).',
    columns: [
      { name: 'id', meaning: 'uuid' },
      { name: 'user_id', meaning: 'клиент' },
      { name: 'kind', meaning: 'expired_survey | start_survey | order_rating | referral_nudge' },
      { name: 'order_id', meaning: 'заказ-триггер (у оценки и опроса протухшего)' },
      { name: 'sent_at', meaning: 'когда отправлено' },
    ],
  },
  {
    table: 'client_feedback',
    kind: 'table',
    purpose: 'Ответы клиентов на сообщения воронки: причина или оценка.',
    columns: [
      { name: 'id', meaning: 'uuid' },
      { name: 'user_id', meaning: 'клиент' },
      { name: 'order_id', meaning: 'заказ (у оценки)' },
      { name: 'kind', meaning: 'expired_survey | start_survey | order_rating' },
      { name: 'score', meaning: 'оценка 1–5 (у order_rating)' },
      { name: 'answer', meaning: 'ключ ответа опроса: price, howto, changed, noservice, other / thinking, noservice, unclear, other' },
      { name: 'created_at', meaning: 'когда ответил' },
    ],
    notes: ['Доля ответивших = ответы client_feedback / отправки funnel_sends того же kind за период.'],
  },
  {
    table: 'analytics_event_types',
    kind: 'table',
    purpose: 'Справочник событий поведенческой аналитики: подписи и шаги воронки.',
    columns: [
      { name: 'name', meaning: 'техническое имя события' },
      { name: 'title', meaning: 'человеческое название' },
      { name: 'description', meaning: 'что означает' },
      { name: 'channel', meaning: 'web | miniapp | bot | derived' },
      { name: 'origin', meaning: 'client | server' },
      { name: 'funnel_step', meaning: 'номер шага главной воронки (1–7) или NULL' },
      { name: 'kind', meaning: 'event (пишем сами) | milestone (выводится из таблиц)' },
      { name: 'updated_at', meaning: 'обновлено' },
    ],
  },
  {
    table: 'analytics_timeline',
    kind: 'view',
    purpose: 'Единая лента поведения: телеметрия сайта/бота + денежные вехи заказов + привязка Telegram + выдача VPN.',
    columns: [
      { name: 'occurred_at', meaning: 'когда' },
      { name: 'name', meaning: 'событие (page_view, catalog_open, service_click, order_proposed, invoice_sent, payment_paid, card_issued, subscription_paid, telegram_linked, bot_start, …)' },
      { name: 'kind', meaning: 'event | milestone' },
      { name: 'channel', meaning: 'web | miniapp | bot | derived' },
      { name: 'user_id', meaning: 'клиент, если опознан' },
      { name: 'telegram_id', meaning: 'telegram_id, если известен' },
      { name: 'web_session_hash', meaning: 'хэш веб-сессии (не сама cookie)' },
      { name: 'order_id', meaning: 'заказ, если событие о заказе' },
      { name: 'order_ref', meaning: 'номер заказа ORD-…' },
      { name: 'props', meaning: 'jsonb свойств: slug, plan, amount_kopecks, src, utm_* и др.' },
      { name: 'subject_key', meaning: 'ЕДИНИЦА СЧЁТА ЛЮДЕЙ: users.id либо web:<hash> либо tg:<id>; считать людей — count(DISTINCT subject_key)' },
    ],
    notes: [
      'В самих событиях user_id не хранится — вьюха резолвит его JOIN-ом; идентичность аналитики — subject_key.',
      "Клики по сервисам в каталоге: name = 'service_click', сервис — props->>'slug'.",
    ],
  },
  {
    table: 'analytics_user_path',
    kind: 'view',
    purpose: 'Путь клиента: та же лента с подписями, паузами и номером сессии (разрыв 30 минут).',
    columns: [
      { name: 'occurred_at', meaning: 'когда' },
      { name: 'subject_key', meaning: 'единица счёта людей' },
      { name: 'user_id', meaning: 'клиент' },
      { name: 'telegram_id', meaning: 'telegram_id' },
      { name: 'web_session_hash', meaning: 'хэш веб-сессии' },
      { name: 'channel', meaning: 'канал' },
      { name: 'kind', meaning: 'event | milestone' },
      { name: 'name', meaning: 'событие' },
      { name: 'title', meaning: 'подпись события' },
      { name: 'description', meaning: 'описание события' },
      { name: 'funnel_step', meaning: 'шаг воронки или NULL' },
      { name: 'order_ref', meaning: 'номер заказа' },
      { name: 'props', meaning: 'jsonb свойств' },
      { name: 'pause', meaning: 'interval с предыдущего события субъекта' },
      { name: 'session_no', meaning: 'номер сессии субъекта' },
    ],
  },
  {
    table: 'analytics_funnel',
    kind: 'view',
    purpose: 'Главная воронка за ВСЁ время: сколько субъектов дошло до каждого из 7 шагов (периода не знает — за период считать по analytics_timeline).',
    columns: [
      { name: 'step', meaning: 'номер шага 1–7' },
      { name: 'name', meaning: 'событие шага' },
      { name: 'title', meaning: 'подпись' },
      { name: 'subjects', meaning: 'уникальных субъектов' },
      { name: 'first_seen', meaning: 'первое событие' },
      { name: 'last_seen', meaning: 'последнее событие' },
    ],
  },
];

/** Чего у роли нет — модель обязана знать об этом ДО запроса. */
export const PANEL_AI_UNAVAILABLE: readonly string[] = [
  'таблица messages (переписка клиентов) и attachments — недоступны',
  'таблица link_tokens и сырая таблица analytics_events — недоступны (только вьюхи)',
  'users: email, phone, display_name, last_seen_ip, web_session_id, notes — недоступны; если спрашивают контакт клиента — ответить, что данные недоступны аналитику, и предложить карточку клиента в панели',
  'payments.raw_payload, referral_payouts.destination, staff: email/telegram_id/totp_*, vpn_subscriptions.subscription_url — недоступны',
];

/** Статус-машина заказа текстом — чтобы модель не выдумывала статусы и переходы. */
export function renderOrderStateMachine(): string {
  const lines = orderStatus.options.map((from) => {
    const to = allowedTransitions[from];
    return `  ${from} → ${to.length > 0 ? to.join(', ') : '(терминальный)'}`;
  });
  return lines.join('\n');
}

/** Словарь в текст системного промпта. */
export function renderSchemaDictionary(): string {
  const parts: string[] = [];
  for (const entry of PANEL_AI_SCHEMA) {
    parts.push(`### ${entry.table} (${entry.kind === 'view' ? 'вьюха' : 'таблица'})`);
    parts.push(entry.purpose);
    for (const col of entry.columns) parts.push(`- ${col.name} — ${col.meaning}`);
    if (entry.notes) for (const note of entry.notes) parts.push(`Примечание: ${note}`);
    parts.push('');
  }
  parts.push('### Недоступно роли');
  for (const item of PANEL_AI_UNAVAILABLE) parts.push(`- ${item}`);
  return parts.join('\n');
}
