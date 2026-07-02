# Changelog

Все заметные изменения проекта. Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), секции по датам milestone'ов (semver-версии пока не выпускаются, `package.json` остаётся `0.0.1` до публичного релиза).

Подробный старый changelog (велся до 2026-06-10) — в истории git: `git show d9a1cb3:CHANGELOG.md`.

---

## 2026-07-02 — Кабинет: возврат на сайт, «Как это работает» → презентация, каталог без «Свой вариант»

### Changed

- **Кнопка возврата на главный сайт Оплатишки** в партнёрском кабинете: топбар (веб — вместо кнопки «назад» мини-аппа), сайдбар, мобильная нижняя навигация (`PartnerCabinet.tsx`).
- **«Как это работает» ведёт прямо на презентацию** (`/partner-presentation.html`, новая вкладка) — промежуточный экран `HowItWorks` в кабинете удалён (кабинет = один дашборд + ссылки на презентацию/сайт).
- **Презентация оживлена маскотом Оплатишки** — hero (`wave`, статичный) + 5 секций (`presenting`/`celebrate`/`thinking`/`idle`); `referrerpolicy=no-referrer` на шрифтах.
- **«Свой вариант…» в кнопочном выборе сервисов скрыт** за флагом `ALLOW_OWN_VARIANT=false` (`StartScreen.tsx`): временно ограничиваем список — часть сервисов не принимает наши карты/подписки. Код сохранён (вернуть = флаг `true`); AI-путь `propose_order`/`customDescription` не затронут.

## 2026-07-02 — Фикс привязки Telegram на мобильных + упрощение кабинета рефералки

### Fixed

- **Привязка Telegram не работала на телефонах (prod).** Кнопка «Связать Telegram» ничего не делала: `window.open(url)` вызывался ПОСЛЕ `await fetch` — мобильные браузеры теряют user-activation и блокируют попап (в логах: `POST /api/auth/telegram/link 200` + токен выпущен, но ни одного consume — пользователь не доходил до бота). Теперь вкладку открываем синхронно в user-gesture, затем перенаправляем на deep-link; fallback — навигация в текущей вкладке (`TelegramLink.tsx`).

### Changed

- **Кабинет партнёра упрощён с 5 экранов до одного дашборда** (`PartnerCabinet.tsx`): всё на одном прокручиваемом экране (ссылка-приглашение, сеть рефералов, спринт/ставка, доход по месяцам, путь к статусу, полная история). Экраны network/link/history/stats как отдельные табы удалены.
- **Кнопка «Сервисы» в тулбаре чата** — возврат к выбору каталога во время диалога, без очистки истории (в отличие от корзины). Раньше был только значок корзины (`ChatClient.tsx`).
- **Презентация партнёрской программы обновлена под одноуровневую** (`public/partner-presentation.html`, `noindex`): убраны дерево на 3 уровня, ставки L2/L3 и командный множитель; калькулятор пересчитан на один уровень (оборот сети × ставка статуса + спринт/буст).

### Ops

- Upstash env на Production подтверждены (`KV_REST_API_URL/TOKEN`) — per-IP rate-limit боевой, не fail-open.

## 2026-07-02 — Аудит: транзакционная целостность платежей + защита от абьюза + интеграционные тесты БД

Итог полного аудита (тесты + транзакции + БД + security). Закрыт 1 критический баг потери денег и 6 важных находок; денежные SQL-гарантии впервые покрыты тестами на реальном Postgres.

### Fixed

- **Critical — оплаченный заказ мог «умереть» без recovery.** `claimPaymentSucceeded` (платёж → `succeeded`) и `transitionOrder(paid)` были двумя отдельными запросами: сбой БД между ними оставлял платёж `succeeded` при заказе в `pending_payment`, а cron `expire-payments` спустя ≤15 мин хоронил ОПЛАЧЕННЫЙ заказ в `expired` («срок оплаты истёк» клиенту). Теперь claim и переход — **в одной транзакции** (`processInvoicePaid`): сбой перехода откатывает и claim, платёж остаётся `pending`, `poll-payment` дообрабатывает. `catch` различает `OrderTransitionError` (легитимная «оплата мёртвого счёта» → алерт) и транзиентный сбой (re-throw → откат). Defense-in-depth: `findExpiredPendingOrders` теперь исключает заказы с успешным платежом (`NOT EXISTS payments succeeded`).
- **Important — «Оплата получена» уходила даже при непройденном переходе в `paid`.** `dispatchPaymentConfirmed`/`dispatchIssueCard` вызывались до проверки результата; клиент, оплативший отменённый счёт, получал «мы обрабатываем заказ». Теперь все побочные эффекты — строго под `paidOk`.
- **Important — merge пользователей терял месячную статистику партнёра.** При привязке Telegram к веб-строке FK `ON DELETE cascade` молча уносил `referral_monthly_stats` (в т.ч. серию `consecutive_met_months` → срыв серийного бонуса) и профиль `referral_partners` с накопленным статусом. `consumeLinkToken` теперь переносит месячную статистику (конфликтные месяцы остаются за telegram-строкой) и мержит профиль партнёра через `GREATEST` (круг/ставка не понижаются, `suspended` — по OR).
- **Important — два конкурентных `confirm_order` создавали два живых инвойса** на один заказ (TOCTOU: проверка статуса и переход не атомарны, `providerRef` каждый раз новый). Клиент мог оплатить второй по уже завершённому заказу. Защита — частичный `UNIQUE(order_id) WHERE status='pending'` на `payments`; проигравший INSERT возвращает существующий pending-инвойс победителя.
- **Important — `/api/orders/propose`, `/confirm`, `/auth/telegram/link` без rate-limit** (анонимный cost-DoS): бескуковый клиент получал свежую сессию — и свежий суточный кап заказов — на каждый запрос. Добавлен per-IP `checkRateLimit` (`web-order`/`web-link`) **до** резолва сессии и любых записей в БД.
- **Important — `transitionReferralPayout` применял любой переход**, включая `paid→requested` (реанимация выплаченной заявки = повторный вывод). Машина статусов (`canTransitionPayout`) теперь форсится в самом репозитории, а не только у вызывающего.

### Added

- **Триггер БД `order_events_append_only`** (`BEFORE UPDATE OR DELETE → RAISE`): инвариант №1 (append-only) больше не держится на конвенции — RLS его не форсил для `service_role`/прямого подключения. Миграция `0018`.
- **Интеграционный контур `packages/db`** на PGlite (WASM-Postgres, реальные миграции): 13 тестов закрывают главный пробел аудита — денежные SQL-гарантии (атомарный claim и его откат в транзакции, идемпотентность webhook, append-only-триггер, guard оплаченного заказа в expire, полный merge пользователей, идемпотентность+reversal ledger'а, машина статусов и анти-перевывод выплат) до этого исполнялись только моками. У `@oplati/db` появился `test`-скрипт (раньше CI молча его пропускал).
- Guard валюты в `accrueReferralForPayment`: начисляем только при `original_currency` USD/NULL (защита от будущего дрейфа базы).

### Changed

- Частичный `UNIQUE(payment_id, beneficiary, level) WHERE status='accrued'` в `referral_accruals` (миграция `0017`): полный индекс блокировал собственный reversal-контракт ledger'а («reversal = новая строка `status='reversed'`»).
- Удалена мёртвая опасная `markPaymentSucceeded` (безусловный UPDATE by id) — риск двойной траты при случайном вызове вместо claim-версии.
- `getWebSessionProfile`: `SUM(amount_rub)::bigint` вместо `::int` (переполнение после ~21,4 млн ₽).
- `/api/alerts/sentry`: зафиксирован комментарием компромисс секрета в query (`?s=` — Sentry webhook не умеет кастомные заголовки; при утечке ротировать секрет).

### Tests

- db 13 (новый пакет), web 235 (+9: транзакция claim↔transition, оплата мёртвого счёта, транзиентный сбой, guard валюты, rate-limit propose), types 87. `typecheck`/`lint`/`build` — зелёные.

## 2026-07-02 — Поддержка в боте: /support → пересылка оператору (interim-handoff)

### Added

- **Команда `/support` в Telegram-боте**: двухшаговый флоу — бот вежливо просит описать проблему, следующее сообщение пользователя пересылается оператору в личку. Плюс однострочная форма `/support <текст>` (работает даже при недоступной БД) и inline-кнопка «Написать в поддержку» под приветствием (`callback_data: support`).
- Получатель обращений — env `SUPPORT_OPERATOR_CHAT_ID` (не задан → дефолт `379336096` в коде — telegram_id владельца). **Оператор обязан один раз запустить бота**, иначе Telegram вернёт 403 на попытку DM (бот честно ответит пользователю об ошибке).
- Сообщение оператору собирает чистая `buildSupportOperatorMessage` (`templates.ts`, parse_mode HTML): имя, `@username`, Telegram ID, кликабельный `tg://user?id=`, текст обращения. Пользовательский ввод экранируется (анти-инъекция разметки), описание обрезается до 3500 символов (лимит Telegram 4096).
- `setMyCommands` в админ-эндпоинте вебхука регистрирует `/menu` и `/support` в нативном меню бота (кнопка ☰), best-effort.
- Pending-state (`awaiting_support_message`) — тот же паттерн meta assistant-сообщения, что и custom-amount; чтение meta в диспатчере унифицировано (`readPendingMeta`, один запрос на сообщение).
- `username` добавлен в `telegramUserSchema` (`@oplati/types`).

### Changed

- `/support` перенесён из mock-заглушки (`SUPPORT_MOCK_TEXT` удалён) в реальный handoff; обработка — ПОСЛЕ rate-limit (inline-форма шлёт человеку, спам недопустим).

### Tests

- `buildSupportOperatorMessage`: экранирование HTML, подстановки-заглушки, обрезка (web 230, +4). typecheck/lint/build зелёные.

## 2026-07-02 — Рефералка упрощена до 1 уровня; каталог сужен + пополнение App Store

### Changed

- **Реферальная программа стала одноуровневой** (решение владельца): партнёр получает процент только с оплат СВОИХ прямых рефералов. `REFERRAL_MAX_LEVEL=1`, ставки уровней 2–3 и командный множитель удалены из `REFERRAL_RATE_TABLE`/`planCommissionAccruals`/прогрессии; максимальная ставка — 7% (Топ-партнёр). Исторические начисления уровней 2–3 в append-only ledger'е остаются валидными; схема БД не менялась (легаси-колонки `active_l2`/`team_multiplier` пишутся нулями).
- **Реферальная ссылка — только Telegram**: единственный канал приглашения — deep-link `t.me/<bot>?start=ref_<code>` (реферал закрепляется при первом `/start` бота). Веб-захват `?ref=` удалён целиком: `apps/web/middleware.ts`, `lib/referral/capture.ts`, `webLink` из снапшота кабинета.
- **Кабинет партнёра упрощён** (`PartnerCabinet.tsx`): одна ставка вместо таблицы уровней, одна сводка «Мои рефералы» вместо трёх карточек сети, блок «Как это работает» (3 шага), кнопка «Поделиться в Telegram» (`t.me/share/url`).
- **Каталог сужен** (решение владельца): в архив (`is_active=false`, записи сохранены в `ARCHIVED_CATALOG` сида для восстановления) выведены airbnb, booking, steam, playstation-plus, xbox-game-pass, discord-nitro, linkedin-premium, notion-plus, telegram-premium, tinder, adobe-creative-cloud, apple-one.

### Added

- Сервис **«App Store (пополнение)»** (`apple-app-store`, custom-amount как Steam: сумму вводит клиент) + иконка. Каталог общий для веба и Telegram — применяется прогоном `db:seed`.

### Tests

- Тесты переписаны под один уровень: types 87, web 226. `typecheck`/`lint`/`build` зелёные.

## 2026-07-01 — Реферальная программа: каркас выплат (Этап E1)

### Added

- **Каркас выплат партнёрам** (mock-исполнитель, движения денег НЕТ). Чистое ядро `packages/types/src/referral-payout.ts`: способы `card_rub`/`crypto_usdt`, комиссия вывода `computePayoutFee` (3.5% карта / 1% крипта, floor, удержание из брутто), маскирование PAN `maskPan` + отсев `isValidLuhn` (**CVV не собираем** — для выплаты не нужен, PCI-запрет), схемы реквизитов `payoutDestinationInput→Stored` (полный PAN не хранится/не логируется), машина статусов заявки `PAYOUT_ALLOWED_TRANSITIONS`.
- Миграция `0016`: enum `referral_payout_method` + колонки `method`/`fee_usd_cents` в `referral_payouts` (nullable). Применена к общей БД.
- `transitionReferralPayout` (условный UPDATE `requested→processing→paid|rejected`, `settled_at` на терминале). `PayoutExecutor` + `MockPayoutExecutor` + чистая оркестрация `settlePayout` (`apps/web/lib/referral/payout-executor.ts`). `requestReferralPayout` + `POST /api/cabinet/referral` принимают опциональные реквизиты.
- Тесты: types 91 (+19), web 225 (+7).

### Decided

- **D-REF-6 частично** (владелец, 2026-07-01): выплаты в рублях (карта) ИЛИ крипте (USDT), комиссия вывода 3.5% / 1%, для карты собираем только номер + ФИО (без CVV). Открыто: кто исполняет выплату (payout-API L&P?) + сеть USDT — реальный `PayoutExecutor` ждёт этого.

## 2026-07-01 — Реферальная программа: прогрессия статусов (Этап C)

### Added

- **Месячный крон `referral-rollup`** (1-е число, 02:00 UTC): прогрессия партнёров — храповик статусов (пороги $500/$2000/$5000, фиксация ставки L1 навсегда), бонусы достижения ($50/$150) / спринт «10+ новых активных» ($30) / серия ($25/$75/$200 за 3 мес. подряд), спринт-буст (+1% при ≥150% порога), командный множитель (L2 2%→2.5%), уведомления партнёру в бот. Чистое ядро `planMonthlyProgression` (`@oplati/types`); идемпотентность на партнёра-за-месяц — `PK(user_id, month)`.
- Таблица `referral_monthly_stats` (миграция `0015`, RLS) — агрегаты прогрессии. Применена к общей БД.

### Changed

- UI-терминология партнёрской программы: **«круг» → «статус»** (идентификаторы кода/БД остались `circle`/`current_circle`).
- `CLAUDE.md` + `docs/architecture.md` актуализированы: добавлена реферальная программа, поправлен статус PaySpace (включён на проде), списки кронов (7) и таблиц (16).

> **Гэп:** milestone'ы 2026-06-11…06-30 (реферальные сеть/ledger/кабинет — Этапы A/B/D; прод-запуск 06-19; PaySpace go-live) в этот changelog не бэкфилл'ены — история в git и `PLAN.md`/`SPEC.md`.

## [Unreleased] — 2026-06-10

### Changed

- **Документация пересобрана с нуля.** Старая спецификация (24 файла в `docs/`, спека-first workflow) и корневые md удалены; ai-factory (22 скилла + `.ai-factory/` + `.ai-factory.json`) удалён. Источник правды теперь — код + `CLAUDE.md`. Новая `docs/`: `architecture.md` (архитектура и устройство кодовой базы), `database.html` (как работает БД), этот changelog.
- Решение: Vercel AI SDK и токен-стриминг в веб-чате **не внедряем** (чат целевой, короткие ответы; свой tool-loop работает в проде на обоих каналах).

## 2026-06-10 — Веб-чат «Оплатишка»

### Added

- **Chat-first веб-чат** на главной странице: комикс-UI (pop-art/halftone, живой маскот), панель заказа, штамп «ОПЛАЧЕНО» (`components/chat/`, `components/comic/`, skill `oplatishka-design`).
- API веб-чата: `/api/chat` (тот же `runAgent()`, что у Telegram — один агент на оба канала; ответ JSON-ом), `/api/chat/history`, `/api/chat/clear`; cookie-сессия (`lib/chat/`).
- `/api/orders/confirm` и `/api/orders/status` — подтверждение и статус заказа из веб-UI.
- Graceful degradation: при недоступных Anthropic/БД чат отвечает понятным текстом, не 500.

## 2026-06-09 — Платежи Love&Pay end-to-end

### Fixed

- **Реальный контракт webhook L&P снят живым вызовом** (discovery): событие `invoice.paid`, id в `data.id`, заголовка `X-Webhook-Event` нет. Тестовая панель кабинета L&P шлёт фейковый формат — ей доверять нельзя. Первый платёж проведён e2e на dev: заказ `ORD-P8S1F` → `paid`.
- `confirm_order` теперь self-call'ит `/api/payments/create` в свой же deployment (а не на `APP_URL`) — иначе preview-деплои били в prod.

### Added

- **Telegram-уведомление клиенту об успешной оплате** (из webhook-обработчика).
- Guards + discovery-лог в webhook L&P для безопасного снятия контракта.

### Decided

- Ротация webhook-секрета L&P — решено не делать (владелец).

## 2026-06-02 — MVP: агент с памятью и tools + фикс пустой БД

### Added

- **AI-агент v2**: полный tool-loop (`runAgent`) с tools `web_search` / `search_catalog` / `propose_order` / `confirm_order` / `request_human`; память диалога (`loadRecentMessages` перед вызовом); приём заказов на **любой** сервис через `customDescription` (не только каталог).
- **Интеграция Love&Pay**: клиент, HMAC-подпись, создание инвойса, webhook-обработчик (+ Vitest-тесты `lib/loveandpay/`).
- **Cron-джобы (Vercel Cron)**: `poll-payment`, `expire-payments`, `renewal-reminder`, `recycle-cards`, `keepalive`. Требуют `CRON_SECRET`; работают только на production-деплое.
- **Каркас фазы карт PaySpace**: таблица `cards` (enum `active/idle/recycled`), репозиторий, клиент `lib/pay-space/` (`createCard`/`topupCard`/`getCard`), job `issue-card` с guard'ом `skipped_no_paypace` (выпуск выключен без env-ключей).
- `db:migrate` — применение полного набора миграций по журналу (в отличие от `db:push`, который диффит schema.ts).

### Fixed

- **Post-mortem «амнезия бота»**: боевая Supabase ушла в auto-pause и потеряла public-схему → все DB-вызовы падали → молчаливая деградация в `runAgentNoTools` без истории. Восстановлено `restore_project` + 7 миграций через `drizzle-kit migrate`; добавлен `keepalive`-cron и heartbeat-алерт в Sentry.

## 2026-05-17 — Расширение схемы БД

### Added

- 5 новых таблиц: `services` (публичный каталог, без RLS), `orders` (CHECK `orders_service_or_custom`), `order_events` (append-only audit log), `payments` (`UNIQUE(provider, provider_ref)` — идемпотентность webhook'ов), `attachments`. 5 enum'ов, включая `order_status` (13 значений). Все суммы — `integer` в минимальных единицах валюты.
- State machine заказа: `allowedTransitions` + `transitionOrder()` — единственная точка смены статуса.
- Идемпотентный seed каталога (10 сервисов, UPSERT по `slug`).

## 2026-04-30 — Persist диалогов + preview-деплой

### Added

- Repository-функции `getOrCreateUserByTelegramId` (raw-SQL upsert), `getOrCreateActiveConversation`, `appendMessage` (append-only).
- `handle-update.ts` синхронно пишет диалог в Supabase с graceful degradation на ошибках БД.
- API-роуты запиннены в `fra1` (`preferredRegion`), preview-окружение с отдельным dev-ботом `@dev_test_podpiska_bot`.

## 2026-04-28 — Базовая схема БД

### Added

- Таблицы `users`, `staff`, `conversations`, `messages` в Drizzle + RLS; миграции forward-only.

## 2026-04-27 — Telegram webhook + AI v1

### Added

- `/api/bot`: grammY webhook с проверкой `X-Telegram-Bot-Api-Secret-Token`; диспатч `/start` / текст; разбивка ответов по 4096 символов.
- Первая интеграция с Anthropic (`runAgentNoTools`, без tools).
- Два окружения Vercel (Production + Preview) с раздельными ботами.

## 2026-04-22 — Каркас проекта

### Added

- Монорепа pnpm + Turborepo: `apps/web` (Next.js 16, Tailwind v4, Sentry с PII-скраббером, pino, Zod-валидация env, Supabase-клиенты, `/api/health`) + пакеты `@oplati/types`, `@oplati/db`, `@oplati/agent` со строгими границами импортов.
- GitHub Actions: typecheck, lint, tests, security.
