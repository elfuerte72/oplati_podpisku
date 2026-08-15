# Архитектура и устройство кодовой базы

> Справочный документ. Правила разработки и инварианты — в [`CLAUDE.md`](../CLAUDE.md) (источник правды — код + CLAUDE.md). Как работает база данных — [`database.html`](reference/database.html). История изменений — [`CHANGELOG.md`](CHANGELOG.md).

## Что это за продукт

«Оплати подписку» — сервис оплаты иностранных подписок для русскоязычных пользователей. Клиент пишет в Telegram-бот или веб-чат, что хочет оплатить (Netflix, ChatGPT Plus, любой другой сервис), — AI-агент «Оплатишка» находит актуальную цену, создаёт заказ (комиссия `COMMISSION_PERCENT`: на проде 30%, дефолт в коде 10%), выставляет счёт в RUB через Love&Pay. После оплаты — автоматическая выдача виртуальных USD-карт через PaySpace (**на проде включена**; при недоступности ключей — ручное исполнение оператором). Есть одноуровневая партнёрская (реферальная) программа — вознаграждение партнёрам с оплат их прямых рефералов (Этапы A–D на проде, soft-start за флагом `REFERRAL_ENABLED`).

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
│  systemd crontab ──→ /api/cron/* (8 джобов)              │
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

- `src/schema.ts` — вся схема: 16 таблиц + enum'ы. RLS включён везде, кроме публичного каталога `services` (public-read активных записей; помимо тарифов `pricing_policy` хранит пер-сервисные правила оплаты `payment_instructions` — VPN/локация/валюта/billing/ссылка, Zod `servicePaymentInstructions`).
- `src/repositories/` — единственный санкционированный способ работы с данными: `users` (upsert по telegram_id, захват реферера при INSERT + отложенный `setReferrerOnce` для Mini App/поздних заходов), `conversations`, `messages` (append-only), `services`, `orders` (**`transitionOrder()`** — единственная точка смены статуса заказа: валидирует переход по `allowedTransitions`, пишет `order_events` в той же транзакции), `payments` (идемпотентный insert), `cards`, `health` (`pingDb`). Реферальные: `referrals` (дерево `referred_by`, коды, `getReferralAncestors`), `referral-accruals` (ledger начислений + баланс), `referral-cabinet` (read-агрегаты кабинета), `referral-progression` (месячный rollup статусов).
- `drizzle/` — forward-only миграции; `scripts/seed-catalog.ts` — идемпотентный seed каталога.
- `repositories/logger.ts` — интерфейс `RepoLogger` (pino-shape), чтобы пакет не зависел от pino.

### `packages/agent` — AI

Не импортирует `@oplati/db` — с миром общается через интерфейс `ToolHandlers`, реализацию которого инжектит `apps/web`. Это позволяет мокать tools в тестах и при необходимости вынести агента в отдельный сервис.

- `src/index.ts` — `runAgent()` (полный tool-loop на `@anthropic-ai/sdk`: модель → tool_use → handler → tool_result → ... до финального текста) и `runAgentNoTools()` (деградация без БД). Модель — `claude-sonnet-4-6`, override через `ANTHROPIC_MODEL`.
- `src/prompts.ts` — системный промпт Оплатишки, `GREETING`.
- `src/tools.ts` — JSON-схемы 5 tools: `web_search` (серверный tool Anthropic — актуальные цены), `search_catalog`, `propose_order`, `confirm_order`, `request_human`.

### `apps/web` — всё остальное

```
app/
  page.tsx                        веб-чат (главная страница)
  styleguide/                     витрина UI-компонентов
  api/
    bot/route.ts                  Telegram webhook
    chat/route.ts + history/ + clear/   веб-чат API
    payments/create/              создание инвойса L&P (internal, X-Internal-Token)
    payments/loveandpay/          webhook L&P
    orders/confirm/ + status/     подтверждение и статус заказа
    cabinet/ + cabinet/referral/  API мини-аппа + партнёрского кабинета (POST, initData|cookie)
    cron/                         7 cron-эндпоинтов (авторизация CRON_SECRET)
    admin/telegram-webhook/       управление webhook бота без раскрытия токена
    health/route.ts               liveness
  partner/page.tsx                веб-страница партнёрского кабинета /partner
components/
  chat/                           компоненты чата (сообщения, инпут, панель заказа)
  comic/                          комикс-примитивы (halftone, маскот, штамп «ОПЛАЧЕНО»)
  cabinet/ + partner/             мини-апп кабинет + PartnerCabinet (один дашборд рефералки)
lib/
  env.ts / env.server.ts          Zod-валидация env, lazy; server-only re-export
  logger.ts                       pino + redact PII + childLogger(module)
  sentry.ts                       beforeSend PII-scrubber
  supabase/                       browser / server / admin клиенты
  telegram/                       grammY bot singleton, handle-update (диспатч), templates
  tool-handlers/                  реализация ToolHandlers (мост agent → db)
  loveandpay/                     клиент, HMAC-подпись, webhook-handlers (+ Vitest)
  pay-space/                      клиент PaySpace (createCard/topupCard/getCard) — на проде включён
  catalog/                        витрина кнопочного флоу: build/load/propose + пер-сервисные
                                  инструкции оплаты (instructions.ts, «Важно перед оплатой»)
  referral/                       захват реферера (capture) + начисление (accrue) + исполнитель выплат (payout-executor, mock)
  cabinet/                        кабинеты: снапшот/auth Mini App (read, live-balance,
                                  payment-issues) + referral-* партнёрского кабинета
  jobs/                           логика cron-джобов + dispatcher
  chat/                           cookie-сессия и история веб-чата
instrumentation.ts                Sentry server/edge + fail-fast env
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

1. `confirm_order` → внутренний `POST /api/payments/create` (защита `X-Internal-Token`, self-call в свой же deployment). Гейты до счёта: протухшая фиксация цены (`409 order_expired`), контакты плательщика — `422 email_required` всегда и `422 phone_required` от порога `PHONE_REQUIRED_FROM_RUB` (антифрод-трек 2026-08-15). Шлюз выбирает `PAYMENT_PRIMARY_PROVIDER` (**только для нового счёта**); счёт уходит с настоящими email (`users.email`) и IP (`users.last_seen_ip`) плательщика → ссылка клиенту.
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
| `poll-payment` | каждые 5 мин | сверка зависших платежей со шлюзом (включая `payment_review` без потолка давности) + recovery застрявших в `paid` + 7-дневный DM-сторож залипших `payment_review` |
| `expire-payments` | каждые 15 мин | оба оплатимых статуса по таймауту: `pending_payment` и `ready_for_payment`-черновики с протухшей фиксацией цены |
| `renewal-reminder` | 07:00 UTC | напоминания о продлении подписки |
| `recycle-cards` | 03:30 UTC | карты старше `CARD_LIFETIME_DAYS` (180 д) → `release` + `recycled` |
| `retention` | 04:15 UTC | чистка `messages` (90 д) и `payments.raw_payload` (180 д) |
| `referral-recovery` | каждый час | добор пропущенных реферальных начислений (бэкстоп) |
| `referral-rollup` | 1-е число, 02:00 UTC | месячная прогрессия статусов партнёров (гейт `REFERRAL_ENABLED`) |

### 5. Эскалация оператору (частично)

`request_human` пишет `handoff_requested` в `order_events` (дедуп 5 минут, защита от чужого orderId) и говорит клиенту SLA в зависимости от рабочих часов. Целевая схема — Telegram forum-topics (topic = заказ, `/ai_back` возвращает AI) — **не реализована**.

### 6. Виртуальные карты PaySpace (на проде включён)

После `paid` job `issue-card` выдаёт клиенту реквизиты USD-карты: **атомарный claim `paid → in_fulfillment` до операций** (at-most-once) → topup активной карты юзера ИЛИ выпуск новой через PaySpace (cross-client reuse убран — `release` необратим) → карта выпускается на цену + буфер `PAYSPACE_CARD_BUFFER_PERCENT` (20%, запас на VAT/FX/foreign-fee) → реквизиты клиенту в Telegram → `completed` (actor `system`). Контракт PaySpace подтверждён живым вызовом (заморозки в API нет — только withdraw/topup/release). Без `PAYSPACE_API_KEY` срабатывает guard `skipped_no_paypace` — заказ остаётся в `paid` для ручного исполнения; **на проде ключи стоят, выпуск боевой.** Операционный гейт беты — баланс VCC-субаккаунта (на карту нужно `цена + буфер + $4 issue-fee`); при низком балансе `createCard`/`topup` падает уже ПОСЛЕ приёма рублей → заказ `failed` (алёрт `vcc_balance.low`). Полные PAN/CVC никогда не попадают в БД/логи — только `pan_masked`; реквизиты клиенту уходят двумя санкционированными путями: сообщением в Telegram при выпуске и разовым показом в кабинете (`card-details`, live-запрос после проверки `initData`, автоскрытие через 60 с). Recovery — cron `poll-payment` (`findStuckPaidOrders`).

**После выпуска (клиентский путь, 2026-07-18):** экран карты в кабинете показывает live-баланс (снапшот тянет `getCardInfo` с бюджетом 4 с и кэширует его compare-and-set'ом `syncCardBalance` — БД-снимок сам не видит списаний клиента на сайте сервиса), назначение («Для оплаты: <сервис>») и срок (выпуск + 180 дней, синхронно с recycle-cron). Экран выполненного заказа ведёт клиента дальше: пер-сервисная инструкция из `services.payment_instructions`, переход на сайт сервиса, статусы «Ожидает оплаты на сайте / Подписка оплачена / Возникла проблема» (производные от append-only `order_events`, статус-машина не тронута) и «Не проходит оплата?» — чек-лист + отправка полного контекста заказа оператору одним нажатием.

### 7. Реферальная (партнёрская) программа

Одноуровневая сеть (упрощение 2026-07-02, `REFERRAL_MAX_LEVEL=1`): партнёр получает % с каждой успешной оплаты **своих прямых** рефералов (уровни 2–3 и командный множитель удалены; исторические строки уровней 2–3 в ledger'е валидны, новых не появляется). Всё за флагом `REFERRAL_ENABLED` (kill-switch); на проде soft-start. Термин **«статус»** в UI = **`circle`** в коде и БД (0=Клиент..3=Топ-партнёр) — историческое имя, не путать при поиске.

- **Захват сети (Этап A).** `users.referred_by` (self-FK, **immutable** после установки) — захват только через Telegram deep-link (веб-захват `?ref=` удалён), ловится в двух точках: (1) бот `/start ref_<code>` → реферер проставляется при СОЗДАНИИ строки в `getOrCreateUserByTelegramId`, БЕЗ анти-абьюз-гейта; (2) Mini App `initData.start_param` (`captureReferralFromStartParam` → `setReferrerOnce`) + поздний захват на повторном `/start ref_` для существующих строк — оба с гейтом `hasPurchasedOrders`. **Инвариант (фикс 2026-07-02): `referred_by_set_at` в raw-`INSERT` = SQL `now()`, НЕ JS `new Date()`** — Date-объект в bind-параметре ронял кэш запросов (`... Received an instance of Date`), из-за чего захват молча падал только когда реферер задан → реферальные начисления не работали с запуска программы. Коды — Crockford-base32, лениво (`ensureReferralCode`). Merge при привязке TG↔web переносит на выжившую telegram-строку всё денежное дерево удаляемой web-строки: реферера (если своего нет и без цикла), children, ledger-начисления, заявки на вывод, месячную статистику (серия `consecutive_met_months` не теряется) и профиль партнёра через `GREATEST` (статус/ставка не понижаются). **Самореферал гасится там же** (аудит 2026-08-10): перенос `beneficiary` мог сделать строку «заработал сам с себя» (`beneficiary == source`) — такие дописываются компенсирующей `status='reversed'` с `created_at` исходной (иначе месячные агрегаты кабинета уходят в минус). Купленный этим оборотом храповик ставки при этом НЕ разматывается — неизвестно, какая доля оборота была самореферальной; факт пишется в лог, разбирает человек (BACKLOG).
- **Начисление (Этап B).** `accrueReferralForPayment` в `processInvoicePaid` сразу **после** `claimPaymentSucceeded` (at-most-once на победителе гонки webhook↔poll). Прямой реферер (1 уровень), ставка — **зафиксированная `locked_rate_l1_bps` профиля** (решение владельца 2026-08-11: «процент не падает»; `REFERRAL_RATE_TABLE` — таблица порогов для храповика, а не источник расчёта), INSERT строк `commission` в append-only `referral_accruals`. Расчёт и витрина кабинета зовут ОДНУ `effectiveReferralRates` — до 2026-08-11 источников было два, и при рассинхроне партнёр видел одну цифру, а получал другую. Идемпотентность — `UNIQUE(payment_id, beneficiary, level)`. Инвариант: **сумма начислений заказа ≤ его комиссия** (платим из маржи). База — `original_amount` (USD-центы). Пропуски добирает cron `referral-recovery`. `suspended`-партнёр исключён.
- **Прогрессия (Этап C).** Cron `referral-rollup` (1-е число месяца) по каждому партнёру: оборот сети за месяц → **храповик статуса** (порог $500/$2000/$5000 → повышение `current_circle` + фиксация ставки L1 навсегда, не понижается), бонусы достижения ($50/$150) / спринт («10+ новых активных» $30) / серия ($25/$75/$200 за 3 мес. подряд), спринт-буст (+1% при ≥150% порога), командный множитель (L2 2%→2.5% при 5+ активных L2), уведомления в бот. Чистое ядро — `planMonthlyProgression`; идемпотентность на партнёра-за-месяц — `PK(user_id, month)` в `referral_monthly_stats` (INSERT ON CONFLICT DO NOTHING → мутации только на первом заходе). ⚠️ Пропущенный запуск (простой машины 1-го числа) джоб НАХОДИТ и громко зовёт человека (лог + Sentry + DM), но НЕ досчитывает: счётчик «новых активных рефералов» не ограничен сверху по времени, и старый месяц получил бы сегодняшние покупки со спринт-бонусом задним числом — в append-only ledger, без отмены. Разбор и план закрытия — `docs/BACKLOG.md`.
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
