# Архитектура и устройство кодовой базы

> Справочный документ. Правила разработки и инварианты — в [`CLAUDE.md`](../CLAUDE.md) (источник правды — код + CLAUDE.md). Как работает база данных — [`database.html`](reference/database.html). История изменений — [`CHANGELOG.md`](CHANGELOG.md).

## Что это за продукт

«Оплати подписку» — сервис оплаты иностранных подписок для русскоязычных пользователей. Клиент пишет в Telegram-бот или веб-чат, что хочет оплатить (Netflix, ChatGPT Plus, любой другой сервис), — AI-агент «Оплатишка» находит актуальную цену, создаёт заказ (комиссия `COMMISSION_PERCENT`: на проде 30%, дефолт в коде 10%), выставляет счёт в RUB через Freekassa (основной шлюз с 2026-07-28; Love&Pay — резерв). После оплаты — автоматическая выдача виртуальных USD-карт через PaySpace (**на проде включена**; при недоступности ключей — ручное исполнение оператором). Есть одноуровневая партнёрская (реферальная) программа — вознаграждение партнёрам с оплат их прямых рефералов (Этапы A–D на проде, soft-start за флагом `REFERRAL_ENABLED`).

## Архитектурный паттерн: Modular Monolith

Один деплой (Next.js в Docker под Dokploy, VPS во Франкфурте) + три библиотечных пакета в монорепе. Никаких микросервисов: масштаб (~50 заказов/день) не оправдывает распределённость, а границы между модулями обеспечиваются правилами импортов, а не сетью.

```
┌─────────────────────────────────────────────────────────┐
│  apps/web (Next.js 16, Docker/Dokploy, Франкфурт)       │
│                                                         │
│  Telegram ──→ /api/bot ──┐                              │
│  Браузер  ──→ /api/chat ─┤──→ runAgent() ──→ Anthropic  │
│                          │        │                     │
│                          │     tools (5)                │
│                          │        │                     │
│                          │   ToolHandlers ──→ Postgres  │
│                          │                              │
│  Freekassa/L&P ──→ /api/payments/* (webhook'и)           │
│  systemd crontab ──→ /api/cron/* (9 джобов)              │
└─────────────────────────────────────────────────────────┘
         │                    │                  │
   @oplati/agent         @oplati/db        @oplati/types
   (AI, промпты,      (Drizzle schema,    (Zod-схемы,
    tool-схемы)        repositories)      state machine)
```

## Файловая система: кто за что отвечает

### Корень монорепы

| Путь | Назначение |
|---|---|
| `package.json` | корневые скрипты (`dev`/`build`/`typecheck`/`lint` через Turborepo) |
| `pnpm-workspace.yaml` | workspaces: `apps/*`, `packages/*` |
| `turbo.json` | конфигурация задач Turborepo |
| `tsconfig.base.json` | общие строгие TS-опции (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) |
| `infra/crontab.example` | расписание cron → `/etc/cron.d/oplatishka` на VPS |
| `.mcp.json` | MCP-серверы для AI-инструментов |
| `CLAUDE.md` | правила разработки, инварианты, деплой, секреты |

### `packages/types` — контракты

Единственная зависимость — `zod`. Здесь живут Zod-схемы всех границ (webhook-тела Love&Pay, гипотеза контракта PaySpace, Telegram-типы) и **state machine заказа** (`order-state-machine.ts`): таблица `allowedTransitions` + `OrderTransitionError`. И фронт, и бэк, и БД-слой выводят типы отсюда — поэтому пакет не имеет права импортировать ничего из `@oplati/*`.

### `packages/db` — данные

Drizzle ORM поверх self-host Postgres 17 на том же VPS (переезд с Supabase 2026-07-24).

- `src/schema.ts` — вся схема: 25 таблиц + enum'ы. RLS включён на ВСЕХ таблицах (`enableRLS()`); публичный каталог `services` отличается не отсутствием RLS, а политикой public-read активных записей (остальные — deny-by-default, доступ только `service_role`/прямое подключение; помимо тарифов `pricing_policy` хранит пер-сервисные правила оплаты `payment_instructions` — VPN/локация/валюта/billing/ссылка, Zod `servicePaymentInstructions`).
- `src/repositories/` — единственный санкционированный способ работы с данными: `users` (upsert по telegram_id, захват реферера при INSERT + отложенный `setReferrerOnce` для Mini App/поздних заходов), `conversations`, `messages` (append-only), `services`, `orders` (**`transitionOrder()`** — единственная точка смены статуса заказа: валидирует переход по `allowedTransitions`, пишет `order_events` в той же транзакции), `payments` (идемпотентный insert, атомарные `claimPaymentSucceeded`/`claimPaymentTerminal`), `cards`, `link-tokens` (привязка Telegram к веб-сессии), `staff` (персонал панели: TOTP-привязка, одноразовый claim окна кода), `panel` (все выборки админ-панели — своих SQL в панели нет; `countHoldsForPanel` и список холдов делят один `holdsCondition()`), `analytics-panel` (раздел «Аналитика»: деньги/воронка/продукт за период, ряды по дням с нулями, ISO-строки вместо `Date`), `funnel-texts` (оверлей текстов воронки + append-only история — сохранение и сброс пишут историю в той же транзакции), `vpn-subscriptions`, `vcc-balance` (снимки фонда и резервы под заказ), `ai-usage` (дневной токен-бюджет), `analytics`, `freekassa` (nonce), `health` (`pingDb`). Реферальные: `referrals` (дерево `referred_by`, коды, `getReferralAncestors`), `referral-accruals` (ledger начислений + баланс), `referral-cabinet` (read-агрегаты кабинета), `referral-progression` (месячный rollup статусов).
- `migrations/` — forward-only миграции Drizzle (`meta/_journal.json` запекается в образ и сверяется `/api/ready`); `scripts/seed-catalog.ts` — идемпотентный seed каталога, `scripts/manage-staff.ts` — заведение персонала панели (`db:staff`).
- `src/readonly-query.ts` — исполнитель SQL AI-аналитика панели под ОТДЕЛЬНОЙ ролью `panel_ai_ro` (`scripts/panel-ai-role.sql`, ADR 0003): своё подключение по `PANEL_AI_DATABASE_URL`, транзакция `READ ONLY` + `statement_timeout`, запрос уходит extended protocol (`simple: false`) — строку из нескольких команд отвергает сам Postgres — и завёрнут в подзапрос с `LIMIT` (потолок строк); `getDb()` на другую роль не перенацеливается. `src/schema-meta.ts` — имена таблиц и колонок для канареек вне пакета.
- `repositories/logger.ts` — интерфейс `RepoLogger` (pino-shape), чтобы пакет не зависел от pino.

### `packages/agent` — AI

Не импортирует `@oplati/db` — с миром общается через интерфейс `ToolHandlers`, реализацию которого инжектит `apps/web`. Это позволяет мокать tools в тестах и при необходимости вынести агента в отдельный сервис.

- `src/index.ts` — `runAgent()` (полный tool-loop на `@anthropic-ai/sdk`: модель → tool_use → handler → tool_result → ... до финального текста) и `runAgentNoTools()` (деградация без БД). Модель — `claude-sonnet-4-6`, override через `ANTHROPIC_MODEL`.
- `src/prompts.ts` — системный промпт Оплатишки, `GREETING`.
- `src/tools.ts` — JSON-схемы 5 tools: `web_search` (серверный tool Anthropic — актуальные цены), `search_catalog`, `propose_order`, `confirm_order`, `request_human`.

### `apps/web` — всё остальное

Один деплой на всё: сайт, бот, Mini App-кабинет, API и **админ-панель** (`admin.oplatishka.com`
ведёт на тот же сервис через Traefik; отдельного приложения у панели нет).

```
app/
  page.tsx                        веб-чат (главная страница); about/ privacy/ terms/ styleguide/
  cabinet/                        Telegram Mini App — личный кабинет
  partner/                        веб-страница партнёрского кабинета
  payment-success/                страница после оплаты
  admin/                          админ-панель: login/ (+ code/), orders/[shortId], clients/[id],
                                  pending/, holds/, support/[conversationId], feedback/ (лента
                                  ответов воронки), analytics/ (графики за период), ai/ (чат с
                                  AI-аналитиком), texts/ (тексты воронки), partners/ (+ [userId],
                                  payouts/), staff/; свои стили panel.css, error.tsx, not-found.tsx
  api/
    bot/                          Telegram webhook клиентского бота
    staff-bot/                    точка приёма бота ПЕРСОНАЛА (свой secret-token)
    chat/ + history/ + clear/     веб-чат
    orders/propose|confirm|status|problem   заказ на сайте и в Mini App
    payments/create/              счёт у текущего шлюза (+ preflight карточного фонда)
    payments/freekassa/ + loveandpay/       webhook'и ОБОИХ шлюзов (работают всегда)
    cabinet/ + cabinet/referral/  API Mini App (подпись initData) и партнёрского кабинета
    auth/telegram/                привязка Telegram к веб-сессии (link-токены)
    panel/                        операции панели: auth/ (telegram, totp, logout),
                                  orders/ (fulfillment, remind), support/ (assign, reply),
                                  partners/payout, ai/ask (вопрос аналитику), texts/ (save,
                                  reset, test-send)
    cron/                         10 эндпоинтов (CRON_SECRET); в расписании 9 — keepalive остался
                                  в коде без строки крона; расписание — infra/crontab.example
    alerts/sentry/                приём алёртов Sentry
    analytics/ catalog/ profile/  телеметрия, витрина каталога, профиль веб-сессии
    admin/telegram-webhook/       set/get/delete webhook бота без раскрытия токена
    health/ + ready/              liveness (без БД) и readiness (журнал миграций)
proxy.ts                          гейт по хосту: /admin и /api/panel отвечают 404 вне PANEL_HOST
instrumentation.ts                Sentry server/edge + fail-fast env
components/
  chat/ comic/ intro/ catalog/    сайт: чат, комикс-примитивы, интро, кнопочный каталог
  info/                           статические страницы (about/privacy/terms): оболочка, футер, бейдж Freekassa
  cabinet/ partner/ contacts/     Mini App-кабинет, партнёрский кабинет, плашка контактов
  panel/                          UI панели: PanelShell (меню со счётчиками), PanelPageHeader,
                                  PanelPager (одно листание на все списки), PanelFilterSelect
                                  (поле формы поиска, не отдельный виджет), кнопки операций
                                  (RemindPayment, ManualFulfillment, PayoutDecision, SupportReply),
                                  AnalystChat (эфемерный чат), FunnelTextEditor, LocalTime,
                                  LiveRefresh (SSE `/api/panel/events` + опрос 25 с страховкой);
                                  PanelNote + form-feedback (один отклик формы и
                                  двухшаговое подтверждение необратимого); charts/ — серверные
                                  SVG без клиентского JS (BarsByDay, LineByDay, HBars, scale)
lib/
  env.ts / env.server.ts          Zod-валидация env, lazy; server-only re-export
  logger.ts / sentry.ts           pino + redact PII; beforeSend-скраббер Sentry
  http.ts / dedup.ts / redis.ts   fetch с таймаутом на чтение тела; claimOnce (Redis); клиент Redis
  ratelimit.ts / client-ip.ts     Upstash sliding window по бакетам; источник identity (CLIENT_IP_MODE)
  pricing.ts / retention-policy.ts   округление цены вверх до рубля; сроки хранения
  billing-address.ts / deployment-url.ts   адрес плательщика для шлюза; публичный URL стенда
  clipboard.ts                    копирование в буфер для клиента: Clipboard API → execCommand →
                                  честный `false` (в Telegram WebView буфер часто закрыт)
  panel/                          админ-панель: labels (словарь всех текстов), permissions (роли),
                                  login/totp/telegram-login/token/session (вход и сессия), guard
                                  (гейт операции и страницы, Origin), menu-counts (счётчики меню:
                                  pending/holds/support/feedback), desk, remind, fulfillment,
                                  payouts, support, format, vcc-balance, funnel-texts (валидация
                                  для операций), paging (страница в адресе, одна на все списки),
                                  class-names (закрытый словарь имён классов — склейка имени
                                  подстановкой невидима канарейке стилей); analytics/period
                                  (период в адресе, окно по UTC);
                                  ai/ — аналитик: run-sql (валидация, маска, формат), profile,
                                  system-prompt + schema-dictionary (зеркало гранта роли, тест),
                                  ask (ход, кап, учёт логом), chat-state (состояние чата без React)
  funnel/                         воронка обратной связи: gate (привратник — единственная точка
                                  отправки), texts (реестр 22 строк: дефолты из templates.ts,
                                  оверлей из БД с памяткой, рендер и валидация подстановок)
  telegram/                       grammY bot singleton, handle-update (роутер) + флоу: start-menu,
                                  link-flow, support-flow, catalog-callbacks, agent-dialog,
                                  vpn-flow, funnel-callbacks (кнопки fb:*, тексты из реестра);
                                  templates (дефолты строк), limits (лимиты Bot API), amount;
                                  staff-bot-client (бот персонала)
  tool-handlers/                  реализация ToolHandlers (мост agent → db)
  payments/                       gateway (выбор шлюза), capacity (текст отказа preflight), expiry
  freekassa/ + loveandpay/        клиенты, подписи, webhook-handlers обоих шлюзов
  rapira/                         курс USDT/RUB (askPrice) + fallback
  pay-space/                      клиент PaySpace; гейт фонда: funding (требование заказа),
                                  preflight (решение + занятие), snapshot (снимок баланса)
  remnawave/                      клиент панели VPN (ссылки-подписки)
  catalog/                        витрина кнопочного флоу: build/load/propose + инструкции оплаты
  referral/                       захват реферера, начисление, реверс, исполнитель выплат (mock)
  cabinet/                        Mini App: auth (initData), read (снапшот, денилист событий),
                                  actions, live-balance, payment-issues; referral-* партнёрки
  contacts/                       email/телефон/IP плательщика: гейты, redact, троттлинг IP
  alerts/                         streams (потоки → темы ops-группы, единственная точка доставки),
                                  notify-ops (алёрт с обязательным потоком), notify-staff (персоналу:
                                  в тему по капабилити или личкой), format (шаблон сообщения), дедуп окон
  analytics/                      track (server, never-throw) + client (sendBeacon) + identity
  ai/                             дневной токен-бюджет
  security/                       timing-safe сравнение
  jobs/                           логика cron-джобов + dispatcher
  chat/                           cookie-сессия и история веб-чата
```

## Как это работает: основные сценарии

### 1. Диалог (Telegram и веб — один агент)

1. Запрос приходит в `/api/bot` (проверка `X-Telegram-Bot-Api-Secret-Token`; единственный non-200 кейс → `401`) или `/api/chat` (cookie-сессия).
2. Upsert пользователя и активного диалога, append входящего сообщения (`@oplati/db`).
3. Загружается недавняя история → `runAgent(history, toolHandlers)`.
4. Агент крутит tool-loop: ищет цену через `web_search`, сверяется с каталогом, создаёт черновик заказа (`propose_order` — расчёт RUB-суммы: `USD-центы × askPrice USDT/RUB Rapira + COMMISSION_PERCENT` (прод 30%) + надбавка за выпуск карты `CARD_ISSUE_FEE_USD_CENTS` для первой карты), после согласия клиента — `confirm_order`. Примечание: в ЧАТЕ бота этот AI-путь за флагом `BOT_AI_ENABLED` (дефолт выключено); веб-чат `/api/chat` работает всегда.
5. Ответ агента append'ится в БД и уходит клиенту (в Telegram — с разбивкой по 4096 символов).
6. **Graceful degradation:** если БД недоступна — `runAgentNoTools` (бот отвечает, но без памяти и заказов); если Anthropic недоступен — понятный текст с предложением позвать оператора.

### 2. Оплата (Freekassa — основной шлюз, Love&Pay — резерв)

1. `confirm_order` → внутренний `POST /api/payments/create` (защита `X-Internal-Token`, self-call в свой же deployment). Гейты до счёта: протухшая фиксация цены (`409 order_expired`), контакты плательщика — `422 email_required` всегда и `422 phone_required` от порога `PHONE_REQUIRED_FROM_RUB` (антифрод-трек 2026-08-15), и последним — карточный фонд (`422 fulfillment_capacity`, трек vcc-preflight 2026-08-25: нечем выпустить карту — деньги не принимаются). Шлюз выбирает `PAYMENT_PRIMARY_PROVIDER` (**только для нового счёта**); счёт уходит с настоящими email (`users.email`) и IP (`users.last_seen_ip`) плательщика → ссылка клиенту.
2. Заказ: `ready_for_payment → pending_payment` через `transitionOrder()`.
3. Клиент платит → webhook провайдера (`/api/payments/freekassa` или `/api/payments/loveandpay` — **обе ручки живут всегда**, независимо от выбранного шлюза): проверка подписи, Zod-парс, идемпотентность по `UNIQUE(provider, provider_ref)`. Атомарный claim платежа (`pending → succeeded`) **и** переход заказа `→ paid` — **в одной транзакции** (сбой перехода откатывает claim → платёж остаётся `pending` → `poll-payment` дообработает; иначе оплаченный заказ «умер» бы без recovery). Победитель claim'а рассылает уведомление клиенту, запускает issue-card и реферальные начисления. Webhook всегда отвечает `200` (ошибки — в теле), у Freekassa «принято» — тело `YES`.
4. Подстраховка: cron `poll-payment` каждые 5 минут опрашивает зависшие `pending_payment` (потерянные webhook'и; Freekassa о неуспехе вообще не уведомляет — опрос единственный способ узнать про отмену), `expire-payments` закрывает просроченные (но НЕ те, у кого уже есть успешный платёж — защита от захоронения оплаченного заказа).
5. Антифрод-холд: опрос увидел статус `7` → снапшот в `payments.last_provider_status`, заказ в `payment_review` («на проверке банка», не протухает) + клиенту ровно одно автосообщение; исход решает провайдер (`paid`/`failed`), залипание дольше 7 дней — DM-сторож. Кнопка «Проблема с оплатой» (Mini App + сайт) даёт клиенту тот же путь руками.

### 3. Жизненный цикл заказа (state machine)

14 статусов, переходы — только через `transitionOrder()`:

```
draft → clarifying → kyc_required ⇄ clarifying
      ↘ ready_for_payment → pending_payment → paid → in_fulfillment → completed
                                  ↘ expired      ↘ failed                ↘ refund_requested → refunded
                                  ↘ payment_review → paid | failed | cancelled
```

`payment_review` («платёж на проверке банка», антифрод-трек 2026-08-15) — заказ с возможно уже списанными деньгами: НЕ протухает (`expired` из него недостижим намеренно), входы — холд провайдера (poll, статус 7) или кнопка «Проблема с оплатой» («я оплатил»), исход решает провайдер/оператор. Терминальные (`cancelled`, `refunded`, `expired`) — без выходов: заказ не переоткрывается, заводится новый; `failed` и `completed` квази-терминальны (единственный выход → `refund_requested`). Каждый переход = строка в append-only `order_events` в той же транзакции. Append-only форсит триггер БД `order_events_append_only` (UPDATE/DELETE → exception), а не только конвенция кода.

### 4. Фоновые задачи (системный crontab)

`/etc/cron.d/oplatishka` на VPS (шаблон — `infra/crontab.example`) → `GET /api/cron/<job>` с `Authorization: Bearer <CRON_SECRET>` → `lib/jobs/<job>.ts`.

| Job | Расписание | Что делает |
|---|---|---|
| `poll-payment` | каждые 5 мин | сверка зависших платежей со шлюзом (включая `payment_review` без потолка давности) + recovery застрявших в `paid` + 7-дневный DM-сторож залипших `payment_review` + **опрос баланса VCC и запись снимка `vcc_balance_snapshots`** (питание preflight: его свежесть 30 мин рассчитана на этот пятиминутный шаг) |
| `expire-payments` | каждые 15 мин | оба оплатимых статуса по таймауту: `pending_payment` и `ready_for_payment`-черновики с протухшей фиксацией цены |
| `renewal-reminder` | 07:00 UTC | напоминания о продлении подписки |
| `recycle-cards` | 03:30 UTC | карты старше `CARD_LIFETIME_DAYS` (180 д) → `release` + `recycled` |
| `retention` | 04:15 UTC | чистка `messages` (90 д), `payments.raw_payload` (180 д) и протухших занятий карточного фонда (7 д) |
| `referral-recovery` | каждый час | добор пропущенных реферальных начислений (бэкстоп) |
| `referral-rollup` | 1-е число, 02:00 UTC | месячная прогрессия статусов партнёров (гейт `REFERRAL_ENABLED`) |
| `support-housekeeping` | каждые 15 мин (`:07`, мимо `expire-payments`) | разговоры у оператора без реплик клиента дольше 24 ч → `idle` с уведомлением клиенту; обращения «без ответа» дольше 2 ч в рабочее время → алёрт персоналу с правом `support` (дедуп 4 ч, пустой штат → владельцу). На VPS с 2026-08-28 |

### 5. Поддержка: помощник и оператор

Разговор несёт **режим** (`conversations.handoff_mode`: `idle` / `ai` / `operator`) и срок
(`mode_expires_at`); все переходы — через `transitionConversationMode` с условным UPDATE и
служебной строкой `system` в той же транзакции. Модуль поддержки `apps/web/lib/support/` —
единственная точка обработки хода помощника: «входящее → прочитать режим → жёсткий триггер →
маскирование → модель (DeepSeek через профиль движка) → выходной фильтр → записать →
ответить». Всё внешнее — портами (`ports.ts`: состояние, модель, доставка, персонал,
аналитика); боевые реализации в `adapters.ts`, мост к боту — `lib/telegram/support-session.ts`.

Эскалация — четыре источника (жёсткое слово, tool `request_human`, выходной фильтр, авария
модели), один путь `escalate()`: переход `→ operator` с `mode_expires_at = NULL`
(неотвеченное не гаснет никогда), текст клиенту по часам операторов, уведомление персонала с
маркером `support_request` и честным исходом доставки. Продажный `request_human` ведёт в тот
же механизм через колбэк `escalateToHuman`.

Панель: ответ = захват (атомарно, чужой не перебивается), «Вернуть помощнику», «Закрыть».
Крон `support-housekeeping` раз в 15 минут: автозакрытие после суток тишины клиента и алёрт
«без ответа > 2 ч». Подробности и инварианты — `CLAUDE.md`, раздел «Поддержка».

### 6. Виртуальные карты PaySpace (на проде включён)

После `paid` job `issue-card` выдаёт клиенту реквизиты USD-карты: **атомарный claim `paid → in_fulfillment` до операций** (at-most-once) → topup активной карты юзера ИЛИ выпуск новой через PaySpace (cross-client reuse убран — `release` необратим) → карта выпускается на цену + буфер `PAYSPACE_CARD_BUFFER_PERCENT` (20%, запас на VAT/FX/foreign-fee) → реквизиты клиенту в Telegram → `completed` (actor `system`). Контракт PaySpace подтверждён живым вызовом (заморозки в API нет — только withdraw/topup/release). Без `PAYSPACE_API_KEY` срабатывает guard `skipped_no_paypace` — заказ остаётся в `paid` для ручного исполнения; **на проде ключи стоят, выпуск боевой.** Операционный гейт беты — баланс VCC-субаккаунта (на карту нужно `цена + буфер + $4 issue-fee`); до выставления счёта работает preflight (`lib/pay-space/preflight.ts`): не хватает фонда —
`422 fulfillment_capacity`, деньги не принимаются вовсе. Остаточный риск просадки между гейтом и
выпуском сохраняется.low`). Полные PAN/CVC никогда не попадают в БД/логи — только `pan_masked`; реквизиты клиенту уходят двумя санкционированными путями: сообщением в Telegram при выпуске и разовым показом в кабинете (`card-details`, live-запрос после проверки `initData`, автоскрытие через 60 с). Recovery — cron `poll-payment` (`findStuckPaidOrders`).

**После выпуска (клиентский путь, 2026-07-18):** экран карты в кабинете показывает live-баланс (снапшот тянет `getCardInfo` с бюджетом 4 с и кэширует его compare-and-set'ом `syncCardBalance` — БД-снимок сам не видит списаний клиента на сайте сервиса), назначение («Для оплаты: <сервис>») и срок (выпуск + 180 дней, синхронно с recycle-cron). Экран выполненного заказа ведёт клиента дальше: пер-сервисная инструкция из `services.payment_instructions`, переход на сайт сервиса, статусы «Ожидает оплаты на сайте / Подписка оплачена / Возникла проблема» (производные от append-only `order_events`, статус-машина не тронута) и «Не проходит оплата?» — чек-лист + отправка полного контекста заказа оператору одним нажатием.

### 7. Реферальная (партнёрская) программа

Одноуровневая сеть (упрощение 2026-07-02, `REFERRAL_MAX_LEVEL=1`): партнёр получает % с каждой успешной оплаты **своих прямых** рефералов (уровни 2–3 и командный множитель удалены; исторические строки уровней 2–3 в ledger'е валидны, новых не появляется). Всё за флагом `REFERRAL_ENABLED` (kill-switch); на проде soft-start. Термин **«статус»** в UI = **`circle`** в коде и БД (0=Клиент..3=Топ-партнёр) — историческое имя, не путать при поиске.

- **Захват сети (Этап A).** `users.referred_by` (self-FK, **immutable** после установки) — захват только через Telegram deep-link (веб-захват `?ref=` удалён), ловится в двух точках: (1) бот `/start ref_<code>` → реферер проставляется при СОЗДАНИИ строки в `getOrCreateUserByTelegramId`, БЕЗ анти-абьюз-гейта; (2) Mini App `initData.start_param` (`captureReferralFromStartParam` → `setReferrerOnce`) + поздний захват на повторном `/start ref_` для существующих строк — оба с гейтом `hasPurchasedOrders`. **Инвариант (фикс 2026-07-02): `referred_by_set_at` в raw-`INSERT` = SQL `now()`, НЕ JS `new Date()`** — Date-объект в bind-параметре ронял кэш запросов (`... Received an instance of Date`), из-за чего захват молча падал только когда реферер задан → реферальные начисления не работали с запуска программы. **Бот отвечает на `/start ref_`** (2026-09-05): только что закреплённому другу — «ты по приглашению», партнёру — DM о новом друге (без имени и id), на СВОЮ ссылку — подсказка отправить её другу; «ничего не изменилось» (уже закреплён, есть покупки, сбой) — обычное приветствие. Раньше все четыре исхода выглядели одинаково, и партнёры, проверявшие ссылку на себе, считали её сломанной. Новая строка поздний захват не зовёт вовсе (реферер уже стоит INSERT'ом); сказанное клиенту пишется в `messages` с `meta.source = 'referral_feedback'` и в контекст помощника поддержки не идёт. Коды — Crockford-base32, лениво (`ensureReferralCode`); ⚠️ код выдаётся и веб-строке (сайт `/partner` до привязки), поэтому merge переносит его на выжившую строку — иначе розданная с сайта ссылка умирала бы молча. Merge при привязке TG↔web переносит на выжившую telegram-строку всё денежное дерево удаляемой web-строки: реферера (если своего нет и без цикла), children, ledger-начисления, заявки на вывод, месячную статистику (серия `consecutive_met_months` не теряется), профиль партнёра через `GREATEST` (статус/ставка не понижаются) и реферальный код, если у telegram-строки своего нет (коды у обеих — выживает telegram-строки, второй хранить негде: колонка UNIQUE, разбор в `BACKLOG.md`). **Самореферал гасится там же** (аудит 2026-08-10): перенос `beneficiary` мог сделать строку «заработал сам с себя» (`beneficiary == source`) — такие дописываются компенсирующей `status='reversed'` с `created_at` исходной (иначе месячные агрегаты кабинета уходят в минус). Купленный этим оборотом храповик ставки при этом НЕ разматывается — неизвестно, какая доля оборота была самореферальной; факт пишется в лог, разбирает человек (BACKLOG).
- **Начисление (Этап B).** `accrueReferralForPayment` в `processInvoicePaid` сразу **после** `claimPaymentSucceeded` (at-most-once на победителе гонки webhook↔poll). Прямой реферер (1 уровень), ставка — **зафиксированная `locked_rate_l1_bps` профиля** (решение владельца 2026-08-11: «процент не падает»; `REFERRAL_RATE_TABLE` — таблица порогов для храповика, а не источник расчёта), INSERT строк `commission` в append-only `referral_accruals`. Расчёт и витрина кабинета зовут ОДНУ `effectiveReferralRates` — до 2026-08-11 источников было два, и при рассинхроне партнёр видел одну цифру, а получал другую. Идемпотентность — `UNIQUE(payment_id, beneficiary, level)`. Инвариант: **сумма начислений заказа ≤ его комиссия** (платим из маржи). База — `original_amount` (USD-центы). Пропуски добирает cron `referral-recovery`. `suspended`-партнёр исключён.
- **Прогрессия (Этап C).** Cron `referral-rollup` (1-е число месяца) по каждому партнёру: оборот сети за месяц → **храповик статуса** (порог $500/$2000/$5000 → повышение `current_circle` + фиксация ставки L1 навсегда, не понижается), бонусы достижения ($50/$150) / спринт («10+ новых активных» $30) / серия ($25/$75/$200 за 3 мес. подряд), спринт-буст (+1% при ≥150% порога), уведомления в бот. Командного множителя НЕТ (программа одноуровневая с 2026-07-02): легаси-колонки `active_l2`/`team_multiplier` пишутся нулями. Чистое ядро — `planMonthlyProgression`; идемпотентность на партнёра-за-месяц — `PK(user_id, month)` в `referral_monthly_stats` (INSERT ON CONFLICT DO NOTHING → мутации только на первом заходе). ⚠️ Пропущенный запуск (простой машины 1-го числа) джоб НАХОДИТ и громко зовёт человека (лог + Sentry + DM), но НЕ досчитывает: счётчик «новых активных рефералов» не ограничен сверху по времени, и старый месяц получил бы сегодняшние покупки со спринт-бонусом задним числом — в append-only ledger, без отмены. Разбор и план закрытия — `docs/BACKLOG.md`.
- **Кабинет (Этап D).** Веб-страница `/partner` + Telegram-мини-апп используют один `PartnerCabinet` (упрощён 2026-07-02: один прокручиваемый дашборд — ссылка/сеть/доход/статус/история — вместо 5 табов; кнопка возврата на сайт; «Как это работает» → лендинг `public/partner-presentation.html`) и один бэкенд `POST /api/cabinet/referral` (`action: snapshot|payout`; auth — initData мини-аппа ИЛИ web-cookie). Витрина ставок = расчёт (`effectiveReferralRates`, один источник правды).
- **Выплаты (Этап E) — каркас (E1), движения денег НЕТ.** Заявки на вывод копятся в `referral_payouts` (мин. `REFERRAL_MIN_PAYOUT_USD_CENTS`, баланс = ledger − выплаты, гейты TG-привязки/`suspended`). Чистое ядро `packages/types/src/referral-payout.ts`: способы `card_rub`/`crypto_usdt`, **комиссия вывода** `computePayoutFee` (3.5% карта / 1% крипта, floor, удержание из брутто — партнёр получает `amount − fee`), **маскирование PAN** `maskPan` + отсев `isValidLuhn` (**CVV не собираем** — для выплаты не нужен, PCI-запрет; полный PAN не хранится/не логируется), схемы реквизитов `payoutDestinationInput→Stored`, **машина статусов** `PAYOUT_ALLOWED_TRANSITIONS` (`requested→processing→paid|rejected`). БД — `transitionReferralPayout` (условный UPDATE, `settled_at` на терминале). Исполнение — `apps/web/lib/referral/payout-executor.ts`: интерфейс `PayoutExecutor` + `MockPayoutExecutor` + чистая оркестрация `settlePayout` (клейм `requested→processing` → execute → `paid|rejected`). **Реальный исполнитель ещё mock, `settlePayout` нигде не вызывается (семафор)** — ждёт `D-REF-6` (кто выплачивает: payout-API L&P? + сеть USDT); формы реквизитов в UI пока нет (поэтому `destination`/`method` всегда NULL); **антифрод (reversal/clawback/детект накрутки) — E3, не начат**. Деньги не двигаются — всё аддитивно и безопасно. ⚠️ Чтобы заявка не замораживала баланс МОЛЧА (аудит 2026-08-10), она уходит владельцу в Telegram через `after()` — без реквизитов, алёрту хватает суммы и номера, — а оба экрана партнёра (до отправки и после) говорят одно: выплата ручная, реквизиты уточним в Telegram.

Модель данных: `referral_partners` (профиль/статус), `referral_accruals` (append-only ledger, reversal = новая строка `status='reversed'`; идемпотентность commission — частичный `UNIQUE(payment_id, beneficiary, level) WHERE status='accrued'`, чтобы reversal с теми же ключами проходил), `referral_payouts` (заявки; `method`/`fee_usd_cents`/`destination` — Этап E, nullable, маска PAN без CVV; `transitionReferralPayout` форсит машину статусов в БД-слое), `referral_monthly_stats` (агрегаты прогрессии). Границы пакетов те же: расчёт — `@oplati/types` (чистые функции), доступ к БД — `@oplati/db`, оркестрация/API — `apps/web`.

## Окружения и деплой

| | Production | Dev |
|---|---|---|
| Где | Dokploy на VPS `187.124.172.104` (Hostinger, Франкфурт) | там же, приложение `oplatishka-web-dev` |
| URL | `www.oplatishka.com` + apex, бот-webhook на `new.oplatishka.com` | `dev.oplatishka.com` (за Basic Auth) |
| Telegram-бот | `@oplatishkaa_bot` | `@dev_test_podpiska_bot` |
| БД | self-host Postgres 17 `oplatishka-db` | `oplatishka-db-dev` (структура = prod, без клиентских данных) |
| Модель агента | `claude-sonnet-4-6` | Haiku (дешевле для smoke) |
| Триггер деплоя | squash-merge PR в `main` → workflow `Deploy` | push в `dev` |

Боты раздельные, потому что webhook у бота один. Прямой push в `main` запрещён ruleset'ом:
только PR с зелёными `Tests`/`Type Check`/`Lint`/`Build`/`Secret Scan`/`Dependency Review`.
⚠️ **Деплой не применяет миграции** — их применяют вручную, а расхождение ловит `GET /api/ready`
и красит деплой. Устройство VPS и контракт deploy-вебхука —
[`reference/infrastructure.md`](reference/infrastructure.md), процедуры —
[`runbooks/deploy.md`](runbooks/deploy.md).

Эпоха Vercel + Supabase (и реверс-прокси для доступа из РФ) закончилась 2026-07-24; описание
того контура — [`history/vercel-era.md`](history/vercel-era.md), как история, не как ТЗ.

## Наблюдаемость

- **Sentry** — все неожиданные ошибки (`captureException`), PII вычищается в `beforeSend`; критичные деградации (БД недоступна, выпуск карты упал) — отдельные алерты.
- **pino** — структурные логи через `childLogger('module')`; `console.log` запрещён; токены/PAN/CVC редактируются.
- `/api/health` — liveness; cron `keepalive` — heartbeat БД.
