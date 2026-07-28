# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Источник правды — код + этот файл.** Если документ противоречит коду — прав код.
Карта всей документации (что авторитетно, что архив, как её вести) —
[`docs/README.md`](docs/README.md). Коротко:

- **Актуальное:** [`docs/architecture.md`](docs/architecture.md) (устройство кодовой базы), [`docs/BACKLOG.md`](docs/BACKLOG.md) (**единственный** список «на потом»: отложенное, открытые находки аудитов, идеи), [`docs/CHANGELOG.md`](docs/CHANGELOG.md) (история изменений — вести обязательно), [`docs/incidents.md`](docs/incidents.md) (журнал инцидентов — новые фиксировать там).
- **Рунбуки** (`docs/runbooks/`): [`deploy.md`](docs/runbooks/deploy.md) (пайплайн prod/dev + контракт deploy-вебхука Dokploy + смоук), [`backup-restore.md`](docs/runbooks/backup-restore.md) (бэкапы в R2, учение по восстановлению), [`rollback.md`](docs/runbooks/rollback.md) (откат и гашение резерва), [`monitoring.md`](docs/runbooks/monitoring.md) (Grafana Cloud: логи узла в Loki, внешний uptime, алёрты в Telegram; Sentry), [`server-migration.md`](docs/runbooks/server-migration.md) (переезд контура на другой VPS: что чем переносится, порядок окна, грабли).
- **Справочники** (`docs/reference/`): [`remnawave-api.md`](docs/reference/remnawave-api.md) (API панели VPN), [`loveandpay-api-access.md`](docs/reference/loveandpay-api-access.md) (домен + IP-allowlist L&P), [`ai-cost-protection.md`](docs/reference/ai-cost-protection.md) (слои защиты AI-расходов), [`database.html`](docs/reference/database.html) (как работает БД; инфраструктурная часть — эпохи Supabase).
- **Архив** (`docs/history/`) — исполненные планы, закрытые аудиты, устаревшие спеки. **Не удалять** (история решений) и **не использовать как ТЗ**: каждый файл описывает контур, которого уже нет.

Если поведение не очевидно из кода — спросите владельца, не додумывайте.

## О проекте

Telegram-бот + веб-чат для оплаты иностранных подписок русскоязычным пользователям. Клиент пишет, что хочет оплатить, — AI-агент «Оплатишка» находит цену, создаёт заказ, принимает оплату в RUB; исполнение пока ручное (операторы). Масштаб старта — ~50 заказов/день.

**Стек:** TypeScript 5.6 · Node.js 24 · pnpm + Turborepo · Next.js 16 (App Router) · grammY · `@anthropic-ai/sdk` (свой tool-loop, default-модель `claude-sonnet-4-6`, override через `ANTHROPIC_MODEL`) · self-hosted Postgres 17 (переезд с Supabase 2026-07-24; Storage/Auth/Realtime не используются) · Drizzle · Zod · Tailwind v4 · Sentry + pino · Vitest · **Dokploy на VPS** `187.124.172.104` (Docker + Traefik) + системный crontab.

**Осознанно НЕ используем** (не предлагать без явного запроса): Vercel AI SDK и токен-стриминг (чат целевой, короткие ответы; свой tool-loop работает в проде), Trigger.dev (хватает системного crontab; env зарезервирован), shadcn/ui (свой комикс-UI).

## Что работает сейчас

- **Telegram-бот → `/api/bot`** — grammY webhook (проверка `X-Telegram-Bot-Api-Secret-Token`, единственный non-200 кейс → `401`). **Взаимодействие с Оплатишкой в ЧАТЕ бота — за флагом `BOT_AI_ENABLED` (дефолт ВЫКЛЮЧЕНО, 2026-07-03):** при выключенном флаге бот НЕ реагирует на текст/медиа/каталожные inline-кнопки/`/menu` (молчит) — работают только команды `/start`, `/support` и inline-меню, а покупки идут в Mini App; при `BOT_AI_ENABLED=1` — обычный путь `runAgent()` из `@oplati/agent` → Anthropic → tools → Supabase (AI-диалог + кнопочный `/menu`-каталог). Код обоих путей сохранён — флаг это временный выключатель, не удаление. Диалог синхронно пишется в БД с graceful degradation при её недоступности (бот отвечает, но «забывает» историю).
- **Веб-чат → `/api/chat`** — тот же `runAgent()` (инвариант: оба канала используют одного агента), ответ JSON-ом без стриминга. **AI-диалог на сайте — за флагом `WEB_AI_ENABLED` (дефолт ВЫКЛЮЧЕНО, решение владельца 2026-07-19):** при выключенном флаге любое сообщение в поле ввода получает мгновенную заготовку «выбери сервис в каталоге / поддержка в боте» — без вызова Anthropic, без сессии и записей в БД (rate-limit тоже не зовётся — ответ статический); UI сайта не меняется, покупка кнопочная (`/api/orders/propose`+`confirm`) не затронута. Код агента цел — временный выключатель по образцу `BOT_AI_ENABLED`. История — `/api/chat/history`, сброс — `/api/chat/clear`, сессия по cookie (`lib/chat/session.ts`). Конвертация истории в Anthropic-формат — ОБЩИЙ `toAgentHistory` (`lib/chat/history.ts`, дубль из handle-update.ts удалён 2026-07-18): отрезает ведущие `assistant` — окно `loadRecentMessages(…, 20)` режет по числу строк и при непарной записи начиналось с assistant → Messages API отвечал 400 на каждый ход НАВСЕГДА (чётность окна сохраняется; H-1 аудита). Комикс-UI «Оплатишка» (`components/chat/`, `components/comic/`, skill `oplatishka-design`). Интро при первом визите — `components/intro/IntroOverlay.tsx` (2 кадра, localStorage-флаг).
- **Привязка Telegram к веб-сессии** — `POST /api/auth/telegram/link` выпускает одноразовый токен (TTL 10 мин, таблица `link_tokens`) → deep-link `telegram.me/<bot>?start=link_<token>` → бот в `/start link_*` зовёт `consumeLinkToken` (если у клиента есть и telegram-, и веб-строка в `users` — merge в одной транзакции, выживает telegram-строка, children переезжают) → клиент поллит `GET /api/auth/telegram/link/status`. Точки входа UI: интро, панель профиля, карточка-гейт в чате (`components/chat/TelegramLink.tsx`). **После привязки** панель профиля (`ProfilePanel.tsx`) вместо кнопки Telegram показывает **«Личный кабинет»** — ссылку на Mini App (`cabinetUrl` из `/api/profile` ← `cabinetDeepLink()`: задан `TELEGRAM_MINIAPP_SHORTNAME` → прямой `telegram.me/<bot>/<shortname>`, иначе fallback `telegram.me/<bot>?start=cabinet` через /start-меню с web_app-кнопкой; веб-браузер сам открыть web_app-кнопку не может). Аватар в профиле осознанно НЕ показываем (у веб-сессии нет `initData`; тянуть фото через Bot API `getUserProfilePhotos` + прокси ради кружка не стали) — только имя из Telegram. **Механика перехода (фикс мобильной привязки 2026-07-03):** токен выпускается ЗАРАНЕЕ при рендере кнопки (prefetch с гейтом видимости; перевыпуск по TTL; rate-limit `web-link` поднят 5→10/мин), кнопка — настоящая `<a href="telegram.me/...">`: universal link открывает приложение Telegram только при прямом тапе; прежняя схема `window.open('about:blank')` + `location.replace` после `await` на iOS/in-app-браузерах не доводила пользователя до бота (токены выпускались, но не потреблялись — видно в `link_tokens.used_at IS NULL`). При `waiting` показывается fallback «скопировать ссылку». **Handoff заказа в бота:** после успешного `consumeLinkToken` бот ищет свежий (≤24 ч) заказ `ready_for_payment` и, если нашёл, сразу выставляет счёт (`confirmOrder`) и шлёт ссылку оплаты в чат — возвращаться в мобильный браузер не нужно; сбой handoff не роняет привязку (обычный успех-текст). `payments/create` при повторном confirm заказа в `pending_payment` идемпотентно возвращает существующий pending-инвойс (`repeat_confirm`), поэтому живая веб-вкладка, повторившая подтверждение после привязки, получает ту же ссылку. **Гейт оплаты:** веб-пользователь без `telegram_id` не получает платёжную ссылку — `confirm_order` бросает `TelegramLinkRequiredError` (`telegram_link_required`), т.к. чек и реквизиты карт доставляются только в Telegram. **Мобильный сайт — воронка в Telegram:** баннер «Продолжить в Telegram» (`components/chat/MobileTelegramBanner.tsx`, только <lg, прямая `<a>` на `supportUrl` из `/api/profile`); анти-петля — кнопка «Сайт» в /start-меню бота ведёт на `/?src=tg`, такой визит помечается в sessionStorage и баннер не показывается.
- **Tools агента** (`packages/agent/src/tools.ts`): `web_search` (серверный tool Anthropic — актуальные цены, в каталоге цен НЕТ), `search_catalog`, `propose_order`, `confirm_order`, `request_human`. Заказ принимается на **любой** сервис: из каталога (`serviceId`) или вне его (`customDescription` — свободный текст, оператор перепроверит). Каталог `services` публичен только на чтение активных записей (`RLS + SELECT policy`), запись — только server-side/service role. **Кнопочный веб-выбор (`StartScreen`)** сейчас без пункта «Свой вариант…» — флаг `ALLOW_OWN_VARIANT=false` (2026-07-02): временно ограничиваем список доступными к оплате сервисами (часть карт/подписок не принимаем); код сохранён, AI-путь `customDescription` не затронут. Цена = `курс × USD-цена + COMMISSION_PERCENT` (на проде 30%, дефолт 10%) + разовая **надбавка за выпуск карты** `CARD_ISSUE_FEE_USD_CENTS` (на проде $4=400, дефолт 0) — берётся только когда у клиента нет активной карты (`findActiveByUserId`; при повторной оплате топап без fee); снимок в `orders.card_issue_fee_kopecks` (миграция 0019), экран заказа показывает разбивку «Подписка / Выпуск карты / Итого». Курс USD→RUB (внутренне `usdt_rub`) берётся из публичного Rapira `GET /open/market/rates`, пара `USDT/RUB`, поле `askPrice` (цена покупки USDT за RUB); при ошибке сети/HTTP/контракта — `RATE_FALLBACK_USDT_RUB` (дефолт 81; поднят с 77 2026-07-19, M-14). Курс фиксируется при `propose_order` **на 2 часа** (`TTL_HOURS`; было 24ч — решение владельца 2026-07-18: суточная фиксация = односторонний опцион на курс за счёт маржи). Фиксация форсится сервером (H-2 аудита): переход `ready_for_payment → expired` разрешён в state machine, протухший черновик хоронит cron `expire-payments` ИЛИ гейт `isPriceLockExpired` в `payments/create` (`409 order_expired` → UI говорит «оформи заново»). **Принимаем ТОЛЬКО рубли** (СБП/карта) — USDT/крипту от клиента НЕ принимаем (убрано из GREETING/SYSTEM_PROMPT 2026-07-03).
- **Платежи — Love&Pay (RUB)**: с 2026-07-16 L&P принимает API-запросы только с подтверждённого домена (DNS TXT) + задекларированного IP (иначе `403 DOMAIN_NOT_VERIFIED`/`SOURCE_IP_NOT_ALLOWED`); **сейчас запросы идут НАПРЯМУЮ** — приложение живёт на том самом VPS `187.124.172.104`, чей IP задекларирован, и выходит с него же (проверено 2026-07-25: запрос к их API с VPS отвечает `401 MISSING_HEADERS`, а не `403 SOURCE_IP_NOT_ALLOWED`). CONNECT-прокси (squid `lnp-proxy`, env `LOVEANDPAY_PROXY_URL`) был нужен в эпоху Vercel с динамическим egress; контейнер удалён 2026-07-25 (последний реальный запрос через него — 06:16 UTC того же дня, от гасимого Vercel-деплоя). ⚠️ Конфиг оставлен в `/opt/lnp-proxy/` (`run.sh`), потому что **откат на Vercel без прокси не заработает**: L&P отвергнет запросы с динамических IP. Env не задан → прямое соединение, healthcheck прокси при этом сам себя отключает. Входящий webhook под allowlist не попадает. `confirm_order` → `POST /api/payments/create` (внутренний, защита `X-Internal-Token`) создаёт инвойс → клиент платит по ссылке → webhook `/api/payments/loveandpay` (подпись, идемпотентность через атомарный claim `claimPaymentSucceeded` — `pending→succeeded` одним условным UPDATE, побочные эффекты только у победителя гонки webhook↔poll; `invoice.paid` → `transitionOrder(paid)` + Telegram-уведомление клиенту). **Внимание:** тестовая панель кабинета L&P шлёт фейковый формат событий — реальный контракт (`invoice.paid`, `data.id`) снят живым вызовом, см. `lib/loveandpay/handlers.ts`. **Счёт живёт 1 час** (`INVOICE_TTL_HOURS`, было 24ч — решение 2026-07-18), при выставлении счёта `orders.expires_at` выравнивается по сроку инвойса (`setOrderExpiresAt`, закрыт рассинхрон M-4: cron не хоронит заказ при живом инвойсе); запись платежа + переход `pending_payment` + выравнивание срока — в ОДНОЙ транзакции (M-2; гонка 23505 ловится снаружи, транзакция откатывается целиком). **Недоплата терминальна (M-3):** `amount_mismatch` → платёж и заказ в `failed` (event `payment_amount_mismatch` с expected/got) в одной транзакции + РОВНО один DM владельцу (дедуп атомарным `claimPaymentTerminal`; повторы webhook/poll молчат); частично оплаченный заказ больше не хоронится как «срок истёк» и не ре-алертится 25 часов. **Тех. сбой транспорта** (лежит прокси / таймаут / 5xx L&P после ретраев — классификатор `lib/loveandpay/availability.ts`) → `payments/create` отвечает `503 provider_unavailable`, все каналы (веб-кнопка, кабинет, AI-чат через typed `PaymentProviderUnavailableError`) показывают «технический сбой, заказ сохранён, попробуй позже», а healthcheck прокси запускается сразу через `after()`.
- **Freekassa — ПРИНИМАЕТ РУБЛИ НА ПРОДЕ с 2026-07-28** (`PAYMENT_PRIMARY_PROVIDER=freekassa`, касса `74953`; L&P стал резервом — его вебхук работает, счета им больше не выставляются). Интеграция строго через API (`https://api.fk.life/v1`, не SCI-форма): `lib/freekassa/` (подпись запроса `HMAC-SHA256` по отсортированным значениям через `|`; подпись уведомления `MD5(MERCHANT_ID:AMOUNT:секрет2:MERCHANT_ORDER_ID)`) + вебхук `/api/payments/freekassa`. **Кто принимает деньги — env `PAYMENT_PRIMARY_PROVIDER` (`loveandpay` дефолт | `freekassa`); флаг влияет ТОЛЬКО на создание нового счёта (`lib/payments/gateway.ts`), вебхуки ОБОИХ провайдеров работают всегда** — иначе в момент переключения оплаты по уже выставленным счетам прежнего шлюза не были бы приняты. Ответ вебхука — HTTP 200 всегда (инвариант 6), но принятым уведомление считается по ТЕЛУ `YES`: не-`YES` отдаём намеренно там, где повтор помогает (платёж ещё не найден, невалидная подпись, сбой обработчика). `nonce` API — последовательность Postgres `freekassa_nonce` (миграция 0026, старт 2e9 выше unix-времени), НЕ `Date.now()`: два конкурентных `confirm_order` в одну миллисекунду дали бы одинаковый nonce. `createOrder` НЕ ретраится (мутирующая операция без идемпотентного ключа + растущий nonce — как `createCard` у PaySpace). `AMOUNT` уведомления разбирается точно в копейки без `parseFloat`; `payer_account` (возможный полный PAN) в БД и логи уходит только маской. **Контракт подтверждён живым платежом 2026-07-28** (ORD-ZPP17, 850,62 ₽ по СБП; путь заказ → счёт → вебхук → `paid` → топап карты занял 48 с): `intid` РАВЕН `orderId` из `/orders/create`, а `AMOUNT` уведомления — сумма НАШЕГО счёта БЕЗ комиссии покупателя (её провайдер берёт с плательщика сверху, магазину приходит выставленное). Хронология прогона и оставшиеся неизвестные (реальный TTL счёта у провайдера) — [`docs/reference/freekassa-api.md`](docs/reference/freekassa-api.md). **Из кабинета сняты (2026-07-28):** касса `74953`; **через API доступны только два метода** — СБП `i=44` и карты РФ `i=36` (у остальных нет бейджа «API»); **лимит операции 150 000 ₽** у обоих (минимум 10 ₽ СБП / 50 ₽ карта — ниже нашего порога 500 ₽); **комиссию платит МАГАЗИН** — ползунок «Магазин ↔ Покупатель» выкручен на нас (6% СБП / 7% карты), решение заказчика 2026-07-28; наценка остаётся 30%, то есть комиссия съедает примерно четверть маржи (цена = база × 1.30, после удержания × 1.222). Клиент платит ровно ту сумму, что видит в кнопке. **Механика на случай обратного переключения:** если комиссию вернут на покупателя, сумма на странице провайдера станет выше нашего счёта — тогда о надбавке предупреждают ВСЕ экраны с ценой (витрины web+Mini App, карточка заказа в чате, экран заказа в кабинете, сообщение бота со ссылкой) через общий модуль `lib/payments/buyer-fee.ts` + `buyerFeePercentFor()`. Управляется одним env `FREEKASSA_BUYER_FEE_PERCENT` (на проде **0** → тексты не показываются; дефолт в коде 6): ⚠️ **держать равным ползунку в кабинете провайдера** — API комиссий у них нет, автосверки не существует, и разъезд означает обещание клиенту неверной цифры. Потолок держится в ДВА эшелона: витринный кап `$1200` (клиент упирается до оформления) и рублёвый гейт `FREEKASSA_MAX_AMOUNT_RUB` (дефолт 140 000, `422 above_max_amount` в `payments/create` + симметричная проверка в фоллбэке) — курс плавает, поэтому долларовый кап сам по себе гарантии не даёт. У L&P потолка нет (`maxAmountRubFor` → 0). **Страховка (этап 4, сделан):** `poll-payment` провайдер-агностичен — опрашивает `POST /orders` по НАШЕМУ `paymentId` (уведомление провайдер шлёт ТОЛЬКО об успешной оплате, о неуспехе не сообщает вовсе, поэтому опрос — ещё и единственный способ узнать про отменённый счёт; статусы 1 оплачен / 8 ошибка / 9 отмена / 6 возврат, неизвестный код НЕ терминален). Метрика конверсии «счёт выставлен → оплачен» (`lib/jobs/payment-conversion.ts`, окно 70 мин со сдвигом 10 мин, порог 5 счетов, дедуп DM 60 мин) — единственный сигнал отказа «шлюз отвечает 200, платежи не проходят», транспортный детектор его не видит. **Автофоллбэк** на резервный шлюз при транспортном сбое — за флагом `PAYMENT_AUTO_FALLBACK` (дефолт ВЫКЛ; включать, когда оба шлюза проверены живыми деньгами). ⚠️ Остаётся дыра: шлюз, упавший ПОСЛЕ выставления счёта, виден только клиенту (он уходит по ссылке на домен провайдера) — мы об этом не узнаём.
- **Статус заказа**: `/api/orders/status`, подтверждение — `/api/orders/confirm`.
- **Личный кабинет — Telegram Mini App `/cabinet`** (`components/cabinet/`, бэкенд `POST /api/cabinet`, auth — проверка подписи `initData` на каждый запрос, `lib/cabinet/auth.ts`): кнопочный каталог «сервис → тариф/сумма → заказ» (`CatalogView`, action `propose` → общий `proposeFromCatalog`, channel `telegram`) → экран заказа с построчной разбивкой цены и кнопкой «Оплатить» (`payOrder` → L&P-ссылка через `tg.openLink`; кнопки «Повторить заказ» и «Нужен оператор» убраны 2026-07-03, а их серверные actions `repeat`/`operator` удалены из `/api/cabinet` 2026-07-19 (L-9)), карта клиента с разовым показом реквизитов (`card-details`, live из PaySpace), вход в партнёрку + **реф-ссылка прямо в главном меню** (карточка «Скопировать»/«Поделиться»; поле `referralLink` в снапшоте `/api/cabinet` за `REFERRAL_ENABLED`). UI на SVG-иконках комикс-стиля (`components/comic/icons.tsx`) вместо эмодзи (2026-07-03). **Списка заказов (истории покупок) в кабинете осознанно НЕТ** (решение владельца 2026-07-02) — снапшот `orders` бэкенд по-прежнему отдаёт, UI не рендерит. **`/start` бота** шлёт GREETING (короткое дружелюбное приветствие, без USDT/оператора/«напиши что нужно» — переписано 2026-07-03) с inline-меню (`buildStartMenuKeyboard`): web_app-кнопка «Открыть приложение» (`miniAppUrl()` — prod `APP_URL`/cabinet, preview `VERCEL_URL`), url-кнопка **«Сайт»** (`siteUrl()` + `/?src=tg` — анти-петля с мобильным баннером «Продолжить в Telegram»), «Поддержка» (callback `support`), url-кнопка **«Telegram-канал»** (`TELEGRAM_CHANNEL_URL` = `telegram.me/ooplatishka`, канал создан 2026-07-10; callback `channel` оставлен для уже отправленных старых меню — отвечает ссылкой). `setMyCommands` — только `/support` (`/menu` убран, не работает при выключенном `BOT_AI_ENABLED`). Постоянная reply-клавиатура на `/start` больше не ставится; тексты старых reply-кнопок («Выбрать сервис», «Написать в поддержку») по-прежнему перехватываются для существующих пользователей.
- **VPN Оплатишки — кнопка «🛡 VPN» в /start-меню бота (Remnawave, 2026-07-21).** Callback `vpn` выдаёт персональную ссылку-подписку из панели `panel.mxpkn8ns.ru` (клиент `lib/remnawave/`: Bearer `REMNAWAVE_API_TOKEN` — ТОЛЬКО server-side/env, timeout 10s, без ретраев; Zod-контракт `@oplati/types` подтверждён живыми вызовами 2026-07-21, справочник — [`docs/reference/remnawave-api.md`](docs/reference/remnawave-api.md)). Один telegramId = один юзер панели: username `tg_<id>`, срок +1 календарный месяц (`addOneMonthUtc`, кламп конца месяца), squad `REMNAWAVE_SQUAD_UUID` (Default-Squad — оба сервера: Литва + «При белых списках»), трафик `REMNAWAVE_TRAFFIC_LIMIT_GB` (дефолт 200 ГБ/мес, 0 = безлимит; легаси-юзерам панели лимит подтягивается best-effort при adopt/обновлении — `syncTrafficLimit` через `PATCH /users`). Снимок — таблица `vpn_subscriptions` (миграция 0024; unique по `user_id`/`telegram_id`/`remnawave_uuid`; хранить `response.uuid`, НЕ `vlessUuid`). **Повторное нажатие возвращает ту же ссылку** (идемпотентность: БД → `by-telegram-id` (200+пустой массив = нет юзера, не 404) → создание). **«Обновить ссылку»** (callback `vpn:refresh`) — `POST …/actions/revoke`: `shortUuid`/ссылка меняются (старая умирает сразу), `expireAt` осознанно НЕ продлевается (иначе кнопка = бесплатное продление); юзера панели удалили вручную (404) → выпуск заново. Сообщение — HTML (`<code>`-ссылка копируется тапом) + url-кнопки сторов Happ + «Обновить ссылку»; перед КАЖДЫМ сообщением со ссылкой — альбом скриншотов `public/vpn/happ-step-*.jpg` (решение владельца 2026-07-21; с текущего деплоя, сбой альбома не блокирует выдачу). Не задан токен / лежит БД или панель → понятный текст, не молчание (флоу `lib/telegram/vpn-flow.ts`, тексты в templates.ts). Продление по оплате (L&P) и отключение по истечению панель делает сама по `expireAt` — интеграция с оплатой не реализована (следующий этап).
- **Реферальная (партнёрская) программа** (за флагом `REFERRAL_ENABLED`; на проде soft-start). **Одноуровневая** (упрощение 2026-07-02: уровни 2–3 и командный множитель удалены; `REFERRAL_MAX_LEVEL=1`): партнёр получает процент только с оплат СВОИХ прямых рефералов. Захват реферера — Telegram deep-link (веб-захват `?ref=` + middleware удалены; `users.referred_by`, immutable), ловится в **двух** точках: (1) бот `/start ref_<code>` — реферер проставляется при СОЗДАНИИ строки в `getOrCreateUserByTelegramId`, БЕЗ анти-абьюз-гейта; (2) Mini App `initData.start_param` (`captureReferralFromStartParam` → `setReferrerOnce`) + поздний захват на повторном `/start ref_` для уже существующих строк — оба с гейтом `hasPurchasedOrders` (устоявшегося покупателя не переприсваиваем). `setReferrerOnce` отклоняет установки, создающие цикл в дереве (`wouldCreateCycle` — обход `referred_by` вверх, кап 16, fail-closed; M-1 аудита 2026-07-18, тот же чек давно есть в merge-пути `consumeLinkToken`) — иначе пара A↔B вечно фармила бы комиссию с покупок друг друга. **Инвариант (фикс 2026-07-02): `referred_by_set_at` в raw-`INSERT` = SQL `now()`, НЕ JS `new Date()` — Date-объект в bind-параметре ронял слой кэша запросов (`The string argument must be ... Received an instance of Date`), из-за чего захват молча падал ТОЛЬКО когда реферер задан (обычный `/start` без ref писался нормально); реферальные начисления не работали с запуска программы.** Ссылка-приглашение кабинета — bot deep-link `telegram.me/<bot>?start=ref_<code>` (друг видит бота — контекст); опционально прямой Mini App-link `telegram.me/<bot>/<app>?startapp=ref_<code>` за отдельным флагом `REFERRAL_MINIAPP_DEEPLINK` (на проде выключен — решение владельца в пользу bot-контекста; флаг заведён 2026-07-10, чтобы `TELEGRAM_MINIAPP_SHORTNAME` можно было задать ради кнопки «Личный кабинет» на сайте, не меняя формат реф-ссылки — `referralMiniAppShortName()` в `lib/telegram/deep-links.ts`). Начисление комиссий — `accrueReferralForPayment` в `processInvoicePaid` сразу после `claimPaymentSucceeded` (append-only ledger `referral_accruals`, идемпотентность `UNIQUE(payment_id, beneficiary, level)`; исторические строки уровней 2–3 в ledger'е валидны, новых не появляется; инвариант «сумма начислений заказа ≤ его комиссия»); ставки по «статусам» (в коде — «круги»/`circle`) — `REFERRAL_RATE_TABLE` в `@oplati/types` (4%/4%/6%/7%). Месячная прогрессия — cron `referral-rollup` (`planMonthlyProgression`: храповик статусов, бонусы достижения/спринт/серия, спринт-буст, уведомления; идемпотентность на партнёра-за-месяц через `PK(user_id, month)` в `referral_monthly_stats`; легаси-колонки `active_l2`/`team_multiplier` пишутся нулями, миграций не было). Кабинет — веб `/partner` + мини-апп (`components/partner/PartnerCabinet.tsx`, единый бэкенд `POST /api/cabinet/referral`): один прокручиваемый дашборд (ссылка/сеть/доход/статус/история) + кнопка возврата на сайт; «Как это работает» ведёт на маркетинговый лендинг `public/partner-presentation.html` (одноуровневый, `noindex`). **Выплаты (Этап E) — каркас (E1) есть, реального движения денег НЕТ:** способы `card_rub`/`crypto_usdt`, комиссия вывода `computePayoutFee` (3.5% карта / 1% крипта, удержание из брутто), маскирование PAN + отсев Луна (`packages/types/src/referral-payout.ts`; **CVV не собираем** — для выплаты не нужен, PCI-запрет), схемы реквизитов input→stored (полный PAN не хранится/не логируется), машина статусов заявки, `transitionReferralPayout`, `PayoutExecutor` + `MockPayoutExecutor` + чистая оркестрация `settlePayout` (`apps/web/lib/referral/payout-executor.ts`). **Реальный исполнитель ещё mock** — ждёт `D-REF-6` (кто выплачивает: payout-API L&P? + сеть USDT); `settlePayout` нигде не вызывается (семафор), формы реквизитов в UI пока нет, антифрод (E3) не начат. Исторические спека и план (⚠️ описывают ТРЁХуровневую схему до упрощения 2026-07-02, содержимое расходится с кодом) — [`docs/history/spec-2026-06-referral-program.md`](docs/history/spec-2026-06-referral-program.md) + [`docs/history/plan-2026-06-referral-program.md`](docs/history/plan-2026-06-referral-program.md). **UI-термин — «статус»; в коде и БД идентификатор остался `circle`/`current_circle`.**
- **Клиентский путь (ТЗ 2026-07-18)**: (1) первый экран сайта — УТП («Оплачивай зарубежные подписки рублями» + 3 галочки) с кнопками «Выбрать сервис» и «Как это работает» (онбординг 3 шага с прогрессом «N из 3» — `components/chat/HowItWorksOverlay.tsx`; подпись «Итоговую сумму увидишь до оплаты»). (2) **Пер-сервисные правила оплаты** — `services.payment_instructions` (jsonb, миграция 0022; Zod `servicePaymentInstructions` в `@oplati/types`: requiresVpn/vpnLocation/requiredCurrency/billingInstructions/paymentUrl/paymentNotes; seed заполняет 13 активных сервисов) → в витрину (`CatalogService.instructions`) → блок «Важно перед оплатой» (`components/catalog/ServiceInstructions.tsx`) на карточке сервиса (web StartScreen + Mini App CatalogView) и на экране заказа; VPN больше НЕ общий совет (ТЗ §5), битая запись не прячет сервис (instructions: null → generic-текст). (3) Прозрачная цена: кнопка оплаты содержит сумму («Оплатить 2 490 ₽» — web ChatClient + Mini App OrderDetailView), раскрывашка «Как рассчитана сумма» (цена $, зафиксированный курс из `orders.usdt_rub_rate_kopecks`, комиссия, выпуск карты), подпись «Цена зафиксирована до <expiresAt>». (4) Экран карты в кабинете: **live-баланс** (снапшот кабинета тянет реальный баланс из PaySpace `getCardInfo` для основной карты с бюджетом 4 с и кэширует в БД через `syncCardBalance` — БД-снимок сам по себе не видит списаний клиента на сайте сервиса; сбой/таймаут → последний известный снимок; `lib/cabinet/live-balance.ts`; `syncCardBalance` — **compare-and-set** по прочитанному балансу (проигрыш гонки параллельному topup из issue-card → кэш не трогаем) и осознанно НЕ трогает `last_used_at` — иначе просмотр кабинета мешал бы recycle-cron) / «Для оплаты: <сервис последнего заказа>» / «Действует до» (createdAt + `CARD_LIFETIME_DAYS`=180д, синхронно с recycle-cron), кнопки «Перейти на сайт сервиса» (paymentUrl) / «Инструкция» / «Не проходит оплата?»; показанные реквизиты автоскрываются через 60 с (ТЗ §4). (5) Пост-выпускные статусы заказа («Ожидает оплаты на сайте сервиса» / «Подписка оплачена» / «Возникла проблема») — производные от append-only событий `subscription_activated`/`payment_issue_reported` в `order_events` (статус-машина НЕ тронута, completed терминален); действия `/api/cabinet`: `payment-issue` (чек-лист самопроверки + выбор типа проблемы; оператору автоматически уходит контекст: номер заказа, сервис, тариф, сумма, статус карты, тип ошибки — `buildPaymentIssueOperatorMessage` с redact PAN-подобных последовательностей в комментарии, доставка через общий `lib/telegram/support.ts`, дедуп 5 мин) и `subscription-paid` (идемпотентно); оба — серверный гейт `status='completed'`. Страна выпуска карты публично НЕ указывается («виртуальная карта», не «американская/карта США») — проверять при добавлении текстов. Задеплоено на прод PR #81 (2026-07-18).
- **Cron (`infra/crontab.example` → `/etc/cron.d/oplatishka` на VPS → `/api/cron/*` → `lib/jobs/*`; авторизация `Authorization: Bearer <CRON_SECRET>`)**: `poll-payment` (каждые 5 мин: подстраховка от потерянных webhook'ов + recovery зависших в `paid` через `findStuckPaidOrders` → повтор `issue-card`, гейт `isPaySpaceConfigured`; + healthcheck L&P-прокси `lib/jobs/proxy-health.ts` — H-3 аудита, SPOF приёма денег: сетевая ошибка/таймаут CONNECT → Sentry `lnp_proxy_down` + DM владельцу через `notifyOps` с дедупом 60 мин; вне гейта PaySpace), `expire-payments` (15 мин; хоронит ОБА оплатимых статуса с истёкшим `expires_at` — `pending_payment` И `ready_for_payment`-черновики с протухшей фиксацией цены, `findExpiredPayableOrders`), `renewal-reminder` (07:00, дедуп через order-event `renewal_reminder_sent` — окно выборки шире шага крона, иначе 3-4 дубля), `recycle-cards` (03:30, закрывает карты старше `CARD_LIFETIME_DAYS` от выпуска — `release`+`recycled`, в ЛЮБОМ статусе; шага «active→idle по простою» больше нет, решение владельца 2026-07-25), `keepalive` (в crontab НЕ переносили: это была анти-автопауза Supabase free tier, у self-host Postgres автопаузы нет; роут в коде остался), `referral-recovery` (каждый час — добор пропущенных реферальных начислений), `referral-rollup` (1-е число месяца, 02:00 UTC — месячная прогрессия статусов, гейт `REFERRAL_ENABLED`), `retention` (04:15 — M-13: `messages` старше 90 дней удаляются, `payments.raw_payload` старше 180 дней очищается батчами; `orders`/`order_events` не трогаются — аудит-след).
- **Защита AI-расходов (оба канала)**: Haiku-роутер перед агентом (`packages/agent/src/router.ts` — приветствие/оффтоп/инъекция получают каннед-ответ без Sonnet; при сомнении и при ошибке роутера — fail-open в агента; выключатель `AI_ROUTER_DISABLED=1`); дневной глобальный токен-бюджет (`ai_usage_daily` + `apps/web/lib/ai/budget.ts`, env `AI_DAILY_TOKEN_BUDGET`, взвешенные токены, fail-open при недоступной БД, Sentry-алерт на пересечении порога); серверные границы в `propose_order` ($1–500; исключение — каталожные «пополнения» Airbnb/Booking/Steam/App Store: до **$1200** строго по slug из `HIGH_VALUE_SERVICE_SLUGS` — потолок опущен с $5000 2026-07-28 под лимит операции Freekassa 150 000 ₽; значение дублируется в `lib/telegram/amount.ts`, `StartScreen.tsx`, `CatalogView.tsx` — держать синхронно; custom-описания остаются на $500; ≤10 заказов/сутки на пользователя; ⚠️ VCC-preflight перед крупным заказом НЕ делается — баланс проверяется только фактом выпуска карты после приёма рублей); per-identity rate-limit (`apps/web/lib/ratelimit.ts`, Upstash sliding window) — `/api/chat` по IP, `/api/bot` по `telegram_id`, ДО роутера; env `KV_REST_API_*` (инжектит Vercel-интеграция Upstash) ИЛИ `UPSTASH_REDIS_REST_*`, не заданы → fail-open, выключатель `RATE_LIMIT_DISABLED=1`.
- **Handoff оператору — interim через `/support` (Telegram).** Команда `/support` (и кнопка «Поддержка» в inline-меню `/start` — callback `support`; тексты старых reply-кнопок ещё перехватываются; нативная команда меню через `setMyCommands`) даёт двухшаговый флоу: бот просит описать проблему (pending-флаг `awaiting_support_message` в meta assistant-сообщения, тот же паттерн, что custom-amount) → следующий текст пересылается оператору в личку. Плюс однострочная форма `/support <текст>` (работает и при недоступной БД). Получатель — `SUPPORT_OPERATOR_CHAT_ID` (ТОЛЬКО env, M-15: дефолт из кода удалён 2026-07-19, значение задано в Vercel prod+preview; не задан → обращение не доставляется + Sentry-алёрт; **оператор обязан один раз запустить бота**, иначе 403 на DM). Сообщение оператору — `buildSupportOperatorMessage` (HTML, экранирование, обрезка ≤3500, `tg://user?id=` для клика; `apps/web/lib/telegram/support-flow.ts` + `templates.ts`). Это НЕ двусторонний диалог — оператор отвечает клиенту вручную. `request_human` (tool AI) по-прежнему только пишет event `handoff_requested` в `order_events` (дедуп 5 мин) + SLA по `isWithinOperatorHours`. Целевая схема — Telegram forum-topics (один topic = один заказ, `/ai_back` возвращает AI) — ещё не начата.
- **Тесты**: Vitest в `apps/web` (loveandpay: client/sign/handlers; rapira: live-rate/fallback; pay-space: client/sign/format; ai: бюджет/роутер; chat: toolCards; ratelimit; security/timing-safe; jobs/issue-card + recycle-cards + referral-rollup + referral-accrual-recovery; cabinet/referral: снапшот/auth/payout; referral/payout-executor + accrue; orders/propose rate-limit; telegram/init-data: `start_param` из подписанного initData), `packages/types` (state machine, схемы L&P/Rapira, referral: ставки + прогрессия + выплаты) и `packages/db` (**интеграционные на PGlite** — реальный Postgres + реальные миграции: атомарный claim и его откат в транзакции, идемпотентность webhook, append-only-триггер, guard оплаченного заказа в expire, merge пользователей, идемпотентность+reversal ledger'а, машина статусов выплат, реферальный захват `getOrCreateUserByTelegramId` ставит `referred_by`+`referred_by_set_at`). Всего web 460, types 110, db 36 (регрессы аудита 2026-07-08: pay-space `rawBody`-утечка/`createCard`-идемпотентность, ratelimit `getClientIp` анти-спуфинг, loveandpay terminal-claim, renewal-reminder дедуп, agent tool-inputs Zod; регрессы аудита 2026-07-11: атомарность terminal-claim+перехода в одной транзакции с откатом (F-05, PGlite + unit), canary PII-скраббера Sentry/pino на pan/cvc/cvv/cardNo/initData/signature/`?s=` (F-06); Rapira 2026-07-14: Zod-контракт, выбор `askPrice`, HTTP/contract fallback и формула 30% + разовые $4; клиентский путь 2026-07-18: схема `servicePaymentInstructions`, пункты `instructionPoints`, passthrough инструкций в витрине, `buildPaymentIssueOperatorMessage` (экранирование/обрезка/контекст), `cardValidUntil` 180 дней; live-balance: приоритет active-карты, CAS-кэш при расхождении и проигрыш гонки параллельному topup (PGlite + unit), деградация на сбое/таймауте, контраст syncCardBalance vs updateBalance по `last_used_at`; redact PAN-подобных последовательностей в комментарии клиента перед DM оператору; аудит 2026-07-18: `toAgentHistory` user-first, `isPriceLockExpired` граница, PGlite `findExpiredPayableOrders` на протухший черновик + `setOrderExpiresAt`, TTL заказа 2ч в propose, healthcheck прокси c дедупом DM, классификатор `isPaymentProviderUnavailable`; M-волна: PGlite цикл-чек `setReferrerOnce` и откат INSERT платежа в транзакции, первый route-тест `payments/create` (транзакционная связка + гейт order_expired), amount_mismatch терминальный путь + дедуп DM на повторе; M-волна 2 (M-5..M-10): парсер суммы с запятой тысяч («1,000»→$1000, «1,00» двусмысленно → invalid), `service_unavailable` на битой pricing_policy (клиентская цена не принимается), Zod-схемы ответов партнёрского API `referral-api-schemas`; волна LOW 2026-07-19: /api/chat флаг, buildOrderExpiredMessage, redirect-manual healthcheck, expire-payments оркестрация (T-3), payOrder строго pending + extractInvoiceLink (T-4), route-тест repeat_confirm/23505 (T-1), таймаут POST L&P без ретрая, retention-джоб, exp_date карты, supportOperatorChatId env-only). **`pnpm typecheck` теперь проверяет и тесты** (L-14).

## Фаза 2 — виртуальные карты (PaySpace) — контракт подтверждён живьём (2026-06)

План фазы (исполнен, архив) — [`docs/history/plan-2026-06-phase2-payspace-cards.md`](docs/history/plan-2026-06-phase2-payspace-cards.md).

Карты выпускает **app.pay.space** (это НЕ Love&Pay; L&P — только приём RUB). Контракт VCC подтверждён OpenAPI-докой + **живым вызовом** (`createCard` реально выпускает карту). Клиент `lib/pay-space/`: `createCard`/`topupCard`/`withdrawCard`/`releaseCard`/`getCardInfo`/`getVccBalance` + HMAC-подпись запросов (`sign.ts`: `X-Timestamp/X-Nonce/X-Signature`, если задан `PAYSPACE_REQUEST_SECRET`); Zod-схемы `packages/types/src/paypace.ts`. **`createCard` НЕ авто-ретраится** (`idempotent:false`) — единственная мутирующая операция без идемпотентного `request_id` у провайдера: повтор на таймаут/5xx выпускал бы вторую профинансированную карту-призрак (потеря funding). Остальные (topup/withdraw/release идемпотентны через `request_id`; GET) ретраятся ×2. **Урок: дока врёт** — суммы приходят то строкой, то числом (`paySpaceMoney`), `exp_date` в формате `MM/YY` (не `YYYY-MM-DD`), опц. поля `card/info` бывают `null`; всё через Zod, дрейф → `PaySpaceContractError`.

`issue-card` (из L&P-webhook): **атомарный claim `paid → in_fulfillment` ДО операций** (`transitionOrderDetailed`, at-most-once); topup активной карты юзера ИЛИ выпуск новой (**cross-client reuse убран — `release` необратим, PAN не делим между клиентами**); async-`topup` поллит `topup/check`, заказ завершается только при `status=completed` (иначе → `failed`); реквизиты клиенту в Telegram → `completed` как `system`; финальное сообщение отправляется HTML-разметкой с копируемыми `<code>` значениями, типом карты из `card/info` и US billing address (Random User Generator `nat=us`, с локальным fallback); recovery — cron `poll-payment`. cron `recycle-cards`: реальный `release`+`recycled` для карт старше `CARD_LIFETIME_DAYS` (180д от выпуска) в ЛЮБОМ статусе + алёрт низкого VCC-баланса. **Срок жизни карты — одно число `CARD_LIFETIME_DAYS` в `@oplati/types/card-lifecycle`** (его же показывает кабинет как «Действует до», внутри него любой новый заказ доливает ту же карту без надбавки за выпуск). Возрастной перевод `active→idle` после 90 дней убран 2026-07-25: он остался от отменённого пула переиспользования карт между клиентами, а на практике лишь лишал клиента долива на 91-й день при обещанных 180. `idle` теперь ставит ТОЛЬКО `issue-card`, когда провайдер отклонил долив (карта протухла/заблокирована) — это и есть вывод из реюза. Просроченная карта исчезает из кабинета и не отдаёт реквизиты независимо от прогона крона: выборки кабинета сами отсекают по возрасту.

**Заморозки нет** (freeze/unfreeze в API отсутствуют): карта выпускается на USD-цену сервиса **+ буфер `PAYSPACE_CARD_BUFFER_PERCENT`** (дефолт в коде 0, на проде задан 20%; округление вверх — запас на местный VAT/НДС по стране карты, FX-конвертацию сети и foreign-fee: реальный charge подписки часто выше витринной цены, напр. эстонская карта $100 → списание ~$114). Буфер только на карте, в цену клиента (`original_amount`) не входит; остаток возвращается на VCC-баланс при `release`. `recycled` = закрытая через `release` карта (статуса `frozen` нет). **Модель префандинга:** VCC-субаккаунт — отдельный USD-кошелёк под карты, пополняется из крипто-баланса (`/vcc/balance/topup/`, T+1 по доке + ~3% fee) + **$4 issue-fee** на каждую новую карту; держать буфер, порог алёрта `PAYSPACE_MIN_VCC_BALANCE_USD_CENTS`.

**Выпуск:** требует `PAYSPACE_API_KEY` (+ `PAYSPACE_REQUEST_SECRET` для подписи); без них guard `skipped_no_paypace` оставляет заказ в `paid` (ручной fulfillment). **Включён на Production (2026-06): ключи стоят, выпуск боевой** — оба окружения выпускают карты. `PAYSPACE_ACCOUNT_ID` больше не нужен (accountId неявен в ключе). **Операционный гейт беты — баланс VCC-субаккаунта:** на каждую карту нужно `цена + буфер (+$4 fee на новую карту)`; при низком балансе `createCard`/`topup` падает уже ПОСЛЕ приёма рублей → заказ в `failed`. Алёрт `vcc_balance.low` (порог `PAYSPACE_MIN_VCC_BALANCE_USD_CENTS`, дефолт $50) в cron `poll-payment`/`recycle-cards`.

**Безопасность реквизитов:** полные `pan`/`cvc` никогда не пишутся в логи/БД/Sentry (только `pan_masked`); полные реквизиты уходят клиенту двумя санкционированными путями: (1) сообщением в Telegram при выпуске карты, (2) разовым показом в кабинете (`card-details` в `/api/cabinet` — live-запрос в PaySpace после проверки подписи `initData` и ownership; ответ не хранится, не кэшируется (`no-store`), не логируется; `lib/cabinet/card-secrets.ts`). Других каналов выдачи нет и добавлять их без threat-model нельзя. `cardType`/`productCode` и billing address не сохраняются в БД, только добавляются в финальное сообщение. Сырое тело ответа card-эндпоинтов (`PaySpaceContractError.rawBody`) — **неперечисляемое** свойство (не попадает в pino/Sentry-сериализацию ошибки при дрейфе контракта, когда тело содержит полный PAN+CVV); `logger.ts` дополнительно redact'ит `err.rawBody`/`*.rawBody`.

## Структура

```
apps/web/          Next.js 16 — единый деплой: веб-чат (page.tsx), API, в будущем админка
  app/api/bot/route.ts            Telegram webhook
  app/api/chat/                   route.ts (агент) + history/ + clear/
  app/api/payments/               create/ (счёт у текущего шлюза) + loveandpay/ + freekassa/ (webhook'и)
  app/api/orders/                 confirm/ + status/
  app/api/cron/                   cron-джобы, расписание в vercel.json
  app/api/admin/telegram-webhook/ set/get/delete webhook бота (X-Internal-Token)
  app/api/health/route.ts         Healthcheck
  components/chat/ + comic/       UI веб-чата (комикс-стиль)
  lib/env.ts                      Zod-валидация env (lazy) + env.server.ts (`server-only`)
  lib/logger.ts                   pino singleton + childLogger(module)
  lib/sentry.ts                   shared Sentry options + PII beforeSend
  lib/telegram/                   handle-update.ts — тонкий роутер апдейтов (распил M-10);
                                  флоу: persist / send / start-menu / link-flow /
                                  support-flow / catalog-callbacks / agent-dialog;
                                  + bot.ts (singleton), templates.ts, amount.ts, support.ts
  lib/tool-handlers/              реализация ToolHandlers (4 tools)
  lib/loveandpay/                 клиент + подпись + webhook-handlers (+ тесты)
  lib/freekassa/                  то же для второго шлюза рублей (docs/reference/freekassa-api.md)
  lib/payments/                   gateway.ts — выбор шлюза (PAYMENT_PRIMARY_PROVIDER) + expiry/availability
  lib/rapira/                     публичный курс USDT/RUB (askPrice) + fallback
  lib/pay-space/                  клиент PaySpace (фаза 2)
  lib/remnawave/                  клиент панели VPN (ссылки-подписки, docs/reference/remnawave-api.md)
  lib/jobs/                       логика cron-джобов + dispatcher
  lib/chat/                       session + history веб-чата
packages/types/    Zod-схемы и state machine заказа — источник правды контрактов
packages/db/       Drizzle schema (src/schema.ts, 17 таблиц) + repositories + migrations/
packages/agent/    AI-агент (runAgent/runAgentNoTools), промпты, tool-схемы; НЕ импортирует db
docs/              справочная документация (architecture, CHANGELOG, BACKLOG, incidents) + history/ (архив)
```

Таблицы БД: `users`, `link_tokens`, `staff`, `conversations`, `messages`, `services` (каталог, без цен; RLS public-read только для `is_active=true`), `orders`, `order_events`, `payments`, `cards`, `attachments`, `ai_usage_daily` (дневной счётчик токенов), `referral_partners` (профиль/статус партнёра), `referral_accruals` (append-only ledger начислений+бонусов), `referral_payouts` (заявки на вывод; `method`/`fee_usd_cents`/`destination` — реквизиты и комиссия, Этап E, nullable), `referral_monthly_stats` (агрегаты прогрессии, `PK(user_id, month)`), `vpn_subscriptions` (снимок VPN-ссылки Remnawave, unique на пользователя). RLS включён. Плюс последовательность `freekassa_nonce` (не таблица) — монотонный nonce запросов к Freekassa.

## Границы пакетов (строго!)

| Пакет | Может импортировать | Запрещено |
|---|---|---|
| `@oplati/types` | только `zod` | `@oplati/*` |
| `@oplati/db` | `@oplati/types` | `@oplati/agent`, `apps/web` |
| `@oplati/agent` | `@oplati/types` | **`@oplati/db` напрямую** (через `ToolHandlers`) |
| `apps/web` | все `@oplati/*` | — |

`@oplati/agent` общается с БД только через интерфейс `ToolHandlers` (реализация в `apps/web/lib/tool-handlers/`). Импорты — только через barrel или объявленные subpath-exports (`@oplati/db`, `@oplati/db/schema`, `@oplati/agent/tools`); приватные пути (`@oplati/db/src/...`) и `../../../` cross-package imports запрещены.

## Архитектурные инварианты (не нарушать)

1. **`order_events` — append-only.** Никогда не `UPDATE`/`DELETE`. Любое изменение статуса = новая строка в той же транзакции, что меняет `orders.status`. Форсится триггером БД `order_events_append_only` (миграция 0018) — `UPDATE`/`DELETE` бросают exception даже для `service_role` (RLS его не покрывает).
2. **Идемпотентность webhook'ов** — `UNIQUE(provider, provider_ref)` на `payments` + `INSERT ... ON CONFLICT DO NOTHING`. Повторный вызов не создаёт дубль или двойной переход. Anti-replay webhook'а L&P держится на атомарном `claimPaymentSucceeded` (подпись без timestamp/nonce), а claim платежа + `transitionOrder(paid)` идут в ОДНОЙ транзакции (`processInvoicePaid`) — сбой перехода откатывает claim, иначе оплаченный заказ застревал бы без recovery. Плюс частичный `UNIQUE(order_id) WHERE status='pending'` — не более одного живого инвойса на заказ. Терминальные события L&P (`expired`/`cancelled`) переводят платёж через симметричный атомарный `claimPaymentTerminal` (`pending→failed` условным UPDATE, null-возврат = idempotent_skip) — НЕ безусловный UPDATE: при гонке с paid-путём не перезаписывает уже `succeeded` платёж в `failed`.
3. **Деньги — integer в минимальных единицах.** `amount_rub` — копейки, `original_amount` и `balance_usd_cents` — USD-центы. Никогда `numeric`/`float`.
4. **State-переходы заказа — только через `transitionOrder()`** (`packages/db/src/repositories/orders.ts`). Прямой `UPDATE orders SET status` запрещён. Разрешённые переходы — `allowedTransitions` в `packages/types/src/order-state-machine.ts`.
5. **Zod на всех границах.** Webhook body, Telegram updates, AI tool inputs, URL params — парсятся схемой из `@oplati/types`. Не `any`, не `as T` без обоснования.
6. **Webhook endpoints всегда `200 OK`** (даже при невалидном input — ошибка в теле), иначе Telegram/L&P ретраят и забивают очередь. Исключение: `/api/bot` отдаёт `401` при неверном secret-token.
7. **Каталог `services` — public read, не public write.** RLS включён; `anon/authenticated` имеют только `SELECT` по policy `services_public_read_active` (`is_active=true`). Seed/изменения каталога — через server-side/service role и Drizzle.
8. **Весь доступ к user-таблицам — только через `service_role`/прямое подключение.** RLS на них — deny-by-default без позитивных политик (браузерный anon-клиент не читает ничего, кроме активного каталога). Модель безопасна, пока не появится клиентский Supabase-запрос к user-данным: тогда deny-by-default его заблокирует — понадобится per-user policy, а не ослабление RLS.
9. **Неаутентифицированные write-эндпоинты — под rate-limit.** `/api/chat`, `/api/orders/propose`, `/api/orders/confirm`, `/api/auth/telegram/link`, `/api/chat/clear`, `/api/cabinet/referral` (веб-ветка) зовут `checkRateLimit` по IP ДО резолва сессии и записей в БД: без cookie каждый запрос иначе получает свежую сессию и свежий суточный кап (cost-DoS на строки users/orders/link_tokens). `GET /api/orders/status` — read-only (`readWebSessionId` + `findUserIdByWebSessionId`, пользователя НЕ создаёт) + ОТДЕЛЬНЫЙ бакет `web-order-status` (60/мин, аудит 2026-07-28): после оплаты клиент опрашивает статус каждые 4 с (≈15/мин), и общий с `propose`/`confirm` бакет на 8/мин он выедал сам — часть поллов ловила 429, а создание следующего заказа с того же IP блокировалось на 5 минут (за CGNAT мобильных операторов это несколько живых клиентов в одном IP). **Источник identity зависит от `CLIENT_IP_MODE` (дефолт `traefik` с 2026-07-28).** На проде он же: доверенный источник — **ПРАВЫЙ элемент `x-forwarded-for`** (его пишет сам Traefik из адреса соединения), а клиентский `x-real-ip` игнорируется — за Traefik он проходит насквозь и подделывается. Значение нормализуется и валидируется как IP (`node:net`.isIP): без этого прокси с `host:port` давал бы новую identity на каждом соединении (эфемерный порт) и лимит обходился бы полностью; мусор ключом не становится, невалидный правый элемент → `unknown` (fail-closed, БЕЗ добора левее). В режиме `vercel` (исторический; ДЕФОЛТОМ быть перестал — прежний дефолт при потере переменной молча включал доверие к подделываемому за Traefik `x-real-ip`, то есть полный обход лимита, CWE-348) берётся `x-real-ip`, а НЕ левый `x-forwarded-for` (подделываем клиентом → ротация обнуляла лимит, CWE-348); `xff` — только fallback (правый элемент). За реверс-прокси РФ-доступа (см. ниже «Доступ из РФ без VPN») Vercel затирает `x-real-ip`/`x-forwarded-for` IP-адресом соединения (= IP прокси, все посетители схлопнулись бы в один лимит), а кастомные заголовки пробрасывает: прокси кладёт реальный IP клиента в `X-Client-IP` + секрет в `X-Proxy-Secret`, `getClientIp` верит `X-Client-IP` ТОЛЬКО при timing-safe совпадении секрета (env `PROXY_SHARED_SECRET`; `*.vercel.app` идёт мимо прокси, где заголовок подделает любой клиент — тот же CWE-348); секрет не задан → ветка мертва, поведение прежнее. Fail-open при незаданном Upstash.

## Команды

```bash
pnpm install                            # установка (один раз)
pnpm dev                                # все пакеты в watch
pnpm build                              # production build
pnpm typecheck                          # tsc --noEmit во всех workspace
pnpm lint                               # eslint
pnpm --filter web dev                   # только Next.js
pnpm --filter web test                  # Vitest в apps/web
pnpm --filter @oplati/types test        # Vitest в packages/types
pnpm --filter @oplati/db db:generate    # сгенерировать миграцию из schema.ts
pnpm --filter @oplati/db db:push        # применить схему напрямую (dev; на проде — db:migrate)
pnpm --filter @oplati/db db:migrate     # применить через migrate (.env из корня)
pnpm --filter @oplati/db db:seed        # seed каталога сервисов
pnpm --filter @oplati/db db:studio      # Drizzle Studio
```

### Миграции БД

**Forward-only через Drizzle.** Схема — `packages/db/src/schema.ts`. Правка схемы → `db:generate` → `.sql` в `packages/db/migrations/` → `db:push` (или `db:migrate`, если push не видит `DATABASE_URL`). Никогда не редактировать применённую миграцию и не править БД через Supabase Dashboard в обход Drizzle. Destructive-изменения — только backwards-compatible (nullable-колонки, два деплоя на удаление).

**Enum-расширения — отдельной миграцией.** `ALTER TYPE ... ADD VALUE` в Postgres нельзя использовать в той же транзакции, где добавленное значение применяется (migrator оборачивает миграцию в транзакцию). Поэтому добавление значения в enum держим отдельной миграцией, не смешивая с DDL/DML, которые это значение используют (иначе `db:migrate` упадёт).

⚠️ **ДЕПЛОЙ НЕ ПРИМЕНЯЕТ МИГРАЦИИ. После каждого мержа с новой миграцией применить её на прод-БД отдельно — сразу, а не «когда включим фичу».** Пайплайн собирает образ и перезапускает сервис, не более. 2026-07-28 этот шаг потерялся: код Freekassa уехал в `main` 26.07, миграции 0025/0026 на прод не попали, и при включении шлюза первый же счёт упал с `relation "freekassa_nonce" does not exist` — **при зелёном деплое, здоровом `/api/health` и без единого алёрта** (см. [`docs/incidents.md`](docs/incidents.md)). Схема «код уехал, миграция нет» не ловится ничем, кроме первого пострадавшего клиента.

Прод-БД снаружи недоступна, поэтому применение — с VPS:

```bash
# 1. что уже применено (hash в журнале = sha256 файла миграции)
ssh root@187.124.172.104 "docker exec \$(docker ps --filter name=oplatishka-db-ry3smb -q) \
  psql -U oplatishka -d oplatishka -t -A -c \
  'select id, hash from drizzle.__drizzle_migrations order by id desc limit 3'"
shasum -a 256 packages/db/migrations/00XX_*.sql   # сверить, чего не хватает

# 2. применить SQL через docker exec (как в разделе про dev-БД выше), затем ОБЯЗАТЕЛЬНО
#    дописать журнал, иначе следующий db:migrate применит миграцию повторно:
#    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
#      VALUES ('<sha256 файла>', <when из migrations/meta/_journal.json>);
```

Пошагово — [`docs/runbooks/deploy.md`](docs/runbooks/deploy.md); автоматизация шага (нужен ssh-ключ в секретах GitHub) — в [`docs/BACKLOG.md`](docs/BACKLOG.md).

## Deployments

**С 2026-07-27 прод и dev живут на Dokploy/VPS `187.124.172.104` — Hostinger, дата-центр
Франкфурт (`data_center_id: 19`), KVM 2: 2 vCPU / 8 ГБ / 96 ГБ.** Машина отдана
**только** Оплатишке, это осознанное условие: до неё контур стоял на бостонском VPS
`177.7.34.106`, где делил два ядра с VPN-панелью Remnawave, dev-стендом и личным ботом —
`idle` упал до 1%, гипервизор начал отбирать до 50% CPU (`%steal`), а до РФ было ~140 мс RTT
против ~40 мс из Франкфурта. Порядок работ и грабли переезда —
[`docs/runbooks/server-migration.md`](docs/runbooks/server-migration.md), цифры разбора —
[`docs/CHANGELOG.md`](docs/CHANGELOG.md) за 2026-07-27.

**На бостонском VPS Оплатишки больше нет.** Там остались VPN-панель Remnawave с живыми
клиентами, личный бот `Vanya_bot`, свой Dokploy и **остановленная** прод-БД
`oplatishka-db-ry3smb` — холодный резерв на случай отката; удалить после недели стабильной
работы. Vercel — резерв ещё более дальний: автодеплой отключён (`vercel git disconnect`),
домены сняты, Vercel Cron погашен WAF-правилом `block-cron-after-dokploy-migration`.
Первый переезд (Vercel → Dokploy, 2026-07-24) описан в
[`docs/history/dokploy-cutover-report.md`](docs/history/dokploy-cutover-report.md).

| | Production | Dev |
|---|---|---|
| Приложение Dokploy | `oplatishka-web` (`7tTmVkOFbpmtP0vriH0oE`) | `oplatishka-web-dev` (`yNIaENiQI2MX5adlDs2Yp`) |
| Ветка | `main` | `dev` |
| Домены | `www.oplatishka.com` + apex, `new.oplatishka.com` (на нём бот-webhook) | `dev.oplatishka.com` (за Basic Auth) |
| БД | self-host Postgres 17 `oplatishka-db` | `oplatishka-db-dev` (структура = prod, без клиентских данных) |
| Бот | `@oplatishkaa_bot` | `@dev_test_podpiska_bot` |
| Модель | `claude-sonnet-4-6` | Haiku (дешевле) |
| Rate-limit | self-host Redis + SRH | `RATE_LIMIT_DISABLED=1` |
| L&P / PaySpace | боевые ключи | **ключей НЕТ намеренно** — иначе тестовый заказ выставил бы реальный счёт и выпустил карту за реальные деньги |
| Sentry | `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` в **Build Args** | не задаём: проект в Sentry один, alert-rules общие — dev-шум сыпался бы теми же алёртами, что реальные проблемы прода |

**Панель Dokploy — `https://dokploypanel.oplatishka.com`, под basic-auth.** Порт 3000 наружу
закрыт firewall'ом Hostinger (`oplatishka-fra-prod`, снаружи открыты только 22/80/443), поэтому
единственный путь в панель — 443 через Traefik, где стоит basic-auth поверх собственного логина
Dokploy. Исключение ровно одно: `/api/deploy` (файл `dokploy-deploy-hook.yml`) — иначе CI
получал бы 401 вместо сборки; роут защищён узким `refreshToken`, который не даёт доступа к панели.
⚠️ Из-за basic-auth команды к API панели по внешнему адресу требуют `-u`; проще ходить с самого
VPS на `http://127.0.0.1:3000` — Traefik и basic-auth при этом не участвуют.

**Безопасность VPS (2026-07-27):** SSH только по ключу (`PasswordAuthentication no`,
`PermitRootLogin prohibit-password`, `MaxAuthTries 3` — файл `sshd_config.d/00-hardening.conf`,
именно `00-`, потому что sshd берёт ПЕРВОЕ найденное значение, а `50-cloud-init.conf` ставит
`yes`); fail2ban на sshd; unattended-upgrades; firewall Hostinger. Плюс swap 2 ГБ
(`vm.swappiness=10`) и ротация docker-логов (`/etc/docker/daemon.json`, 10 МБ × 3) — без неё
json-file растёт неограниченно.

**Деплой — ТОЛЬКО через `.github/workflows/deploy.yml`** (push в `main`/`dev` → gate
typecheck+тесты+lint → `POST /api/deploy/<refreshToken>` → **проверка, что прод реально
обновился**: `/api/health` отдаёт `startedAt` позже момента триггера, иначе workflow красный;
провал любого шага → сообщение в Telegram, если заданы `DEPLOY_ALERT_BOT_TOKEN`/`DEPLOY_ALERT_CHAT_ID`).
Принятый триггер не равен выкаченному релизу — до 2026-07-25 пайплайн заканчивался на «сборка
запущена», и упавшая сборка давала зелёный workflow при старом коде на проде. **`curl exit 28`
в деплое — это внешние эпизоды сетевой недоступности VPS с раннеров GitHub, а НЕ нагрузка от
собственной сборки** (последнее проверено и опровергнуто: `sar` в разгар падения показал load
average 0.25); отсюда `--connect-timeout 10` и 10 попыток — см. [`docs/incidents.md`](docs/incidents.md).
GitHub App Dokploy как источник
триггера больше не используется: он деплоил сразу на push, не дожидаясь CI (красный `main` уехал бы
на боевой контур с живыми платежами), а его отказы не видны из репозитория — вебхук молча потерял
мерж PR #102 и #103, прод пересобирали руками. **С 2026-07-25 установлено: App не «иногда теряет
события», а не работает вообще** — все доставки в его журнале красные (Dokploy отвергает их на
проверке подписи), проверено экспериментом с docs-коммитом, который наш workflow пропускает.
Решение владельца — не чинить. ⚠️ Отвязывать git-провайдера или сужать Repository access **нельзя**:
Dokploy клонирует репозиторий по токену этой установки, сломается и workflow-деплой; глушить App
следует снятием подписки на события — [`docs/runbooks/deploy.md`](docs/runbooks/deploy.md). Ровно та же история была с вебхуком Vercel
(PR #83, 2026-07-18, см. [`docs/incidents.md`](docs/incidents.md)).

**Контракт deploy-вебхука Dokploy (в доках его НЕТ, снят перебором 2026-07-25):**
`POST /api/deploy/<refreshToken>` + заголовок **`X-GitHub-Event: push`** + тело
**`{"ref":"refs/heads/<ветка>"}`** → `200 {"message":"Application deployed successfully"}`.
Без заголовка Dokploy не умеет достать ветку → `301 {"message":"Branch Not Match"}`; ветка обязана
совпасть с `branch` приложения; неизвестный токен → `404 Application Not Found`. Подпись HMAC этому
роуту не нужна (в отличие от `/api/deploy/github`, требующего `X-Hub-Signature-256`).
⚠️ **Флаг `autoDeploy` у приложения обязан быть ВКЛЮЧЁН**, хотя триггер у нас свой: несмотря на
название, это общий выключатель вебхук-деплоев, а не «слушать GitHub App». При выключенном Dokploy
отвечает `400 {"message":"Automatic deployments are disabled for this application"}` и на наш
собственный вызов (проверено на живом проде 2026-07-25).
Токены — в секретах репозитория `DOKPLOY_DEPLOY_TOKEN_PROD`/`DOKPLOY_DEPLOY_TOKEN_DEV`; они узкие
(триггерят сборку ровно одного приложения, не админский `DOKPLOY_API_KEY`), ротация — кнопка
refresh token в Dokploy + обновить секрет.
⚠️ `gh secret set --body -` НЕ читает stdin, а пишет литерал `-` — задавать через
`gh secret set NAME < file`.

**Миграции/seed на dev-БД — ТОЛЬКО с VPS, снаружи она недоступна** (найдено
2026-07-27). ⚠️ `DEV_DATABASE_URL`/`DEV_DATABASE_URL_DIRECT` в корневом `.env`
указывают на **мёртвую dev-Supabase эпохи Vercel** — seed по ним отрабатывает
«успешно» и уходит в никуда, приложение изменений не видит. Настоящая dev-БД —
контейнер `oplatishka-db-dev-*` в overlay-сети swarm: порт наружу не
опубликован, ssh-туннель на IP контейнера (`10.0.1.x`) не проходит. Рабочий
путь — прогнать SQL через `docker exec` на VPS:
```bash
base64 -i my.sql | ssh root@187.124.172.104 "base64 -d > /tmp/q.sql && \
  docker exec -i \$(docker ps --filter name=oplatishka-db-dev -q) \
  psql -U oplatishka -d oplatishka < /tmp/q.sql; rm -f /tmp/q.sql"
```
Строка подключения (с паролем) лежит в env dev-приложения Dokploy. Прод-БД —
так же, контейнер `oplatishka-db-ry3smb`. Shell-env имеет приоритет над
`--env-file` (тот же приоритет у `db:init-roles`) — это по-прежнему верно.

⚠️ **Каталог сервисов живёт в БД, а не в коде.** Мерж в `main` НЕ добавит новый
сервис в витрину: после деплоя нужно отдельно применить seed к прод-БД. Витрина
кэшируется в памяти инстанса 5 минут (`lib/catalog/load.ts`).

⚠️ **dev-домен под Basic Auth, а Telegram его не умеет.** WebView Mini App и
серверы Telegram (скачивают картинки для `sendMediaGroup`) получают `401`.
Исключения вынесены отдельными файлами Traefik на VPS, Dokploy их не
перегенерирует: `oplatishka-dev-webhook.yml` (`/api/bot`) и
`oplatishka-dev-miniapp.yml` (`/cabinet`, `/api/cabinet`, `/api/catalog`, `/_next`, картинки).
⚠️ Список путей — исчерпывающий по факту: пропущенный `/api/catalog` давал
открывшийся кабинет с пустым экраном «Каталог не открылся». При добавлении
экранов в Mini App сверять `grep -rhoE "'/api/[a-z/_-]*'" components/cabinet`.
Данные не открыты: `/api/cabinet` проверяет подпись `initData` на каждом
запросе, сам сайт `/` остаётся под Basic Auth.
Локальная разработка (`pnpm dev`) ходит в dev-БД, не в прод.

**Пайплайн:** feature-ветка → push → PR → CI (`Tests`/`Type Check`/`Lint`/`Build`/`Secret Scan`) →
squash в `main` → workflow `Deploy` пересобирает прод. `Build` отдельно от `Type Check`, потому что
`tsc --noEmit` не видит ошибок пререндера и конфигурации route-сегментов — такой коммит раньше
падал уже при docker build на VPS. `Secret Scan` (gitleaks) — репозиторий публичный, а `.gitignore`
ловит только известные имена файлов; ⚠️ глубина скана зависит от события: на `pull_request` он
читает только коммиты PR, всю историю — лишь `schedule`/`workflow_dispatch`, и в `.gitleaksignore`
нельзя цитировать найденную строку (файл сканируется наравне с остальными). **Main защищён ОДНИМ ruleset'ом
`protectionOplatishka`** (2026-07-25 дубль `protect-main` удалён — при двух наборах правил GitHub
применяет самое строгое из каждого, и удаление «лишнего» молча ослабило бы защиту): прямой push
запрещён, только PR с зелёными `Tests`/`Type Check`/`Lint`/`Build`/`Secret Scan`/`Dependency Review`
(approvals 0 — solo, сам себе аппрув GitHub не даёт); merge-метод только **squash**; force-push и
удаление ветки заблокированы. `Dependency Audit` в обязательные НЕ входит осознанно: у него внутри
`continue-on-error` (у pnpm сломан audit-эндпоинт), он физически не может упасть — гейт по
уязвимостям даёт `Dependency Review`. Новый чек делать обязательным можно только после нескольких
зелёных прогонов: падающий по своей же ошибке required-чек блокирует разом все merge.
Для dev-стенда — push в `dev` (до 2026-07-25 у этой ветки
не было CI вообще; теперь она под тем же гейтом внутри `deploy.yml`).

---

### История: как было на Vercel (оставлено для контекста отката)

Vercel `fra1`. Два окружения с **раздельными Telegram-ботами** (webhook у бота один → шарить нельзя):

- **Production** — `https://www.oplatishka.com` (custom-домен подключён 2026-07-03; env `APP_URL` указывает на него — от него резолвятся mini app `/cabinet`, кнопка «Сайт», презентация партнёрки, payment deep-link, self-call). Дефолтный `oplati-podpisku-web.vercel.app` тоже обслуживает (старые ссылки не ломаются). Бот `@oplatishkaa_bot` (переезд 2026-07-03 со старого `@test_prodipsa_bot` — смена токена в env; username везде резолвится через `getMe`, код не менялся; у старого бота вебхук снят, клиенты должны нажать Start у нового, иначе бот не может писать первым). Auto-deploy на merge в `main`.
- **Preview** — branch-alias `oplati-podpisku-web-git-<branch>-<team>.vercel.app` на каждый push в feature-ветку. Бот `@dev_test_podpiska_bot`. Перед merge — smoke-тест через dev-бота: webhook перерегистрируется на новый preview-URL. **Preview изолирован от прод-данных (F-01) и с 2026-07-18 подключён к отдельной dev-Supabase** `oqwofyipeuzgezdplixn` (лежит в ДРУГОМ Supabase-аккаунте, чем прод, — free-план старого органа исчерпан; claude.ai Supabase MCP видит только прод-орг). Vercel Preview env: `DATABASE_URL`/`DATABASE_URL_DIRECT`/`SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` — dev-значения (записи `SUPABASE_URL`/`ANON_KEY` разделены по окружениям, раньше были общими с продом), `APP_URL` — fallback `oplati-podpisku-web.vercel.app` (код на preview использует `VERCEL_URL`; без APP_URL env-схема роняла деплой), `AI_DAILY_TOKEN_BUDGET=200000` — предохранитель AI-расходов, отдельный `CRON_SECRET` (Vercel Cron на preview не бегает, но cron-endpoints можно дёргать руками), `ANTHROPIC_API_KEY` (прод-ключ) + `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` — **основной агент на Preview/локально работает на Haiku** (дешевле; прод остаётся `claude-sonnet-4-6`, записи разделены по окружениям). Миграции/seed на dev-БД гоняются локально: в корневом `.env` — `DEV_DATABASE_URL`, `DEV_DATABASE_URL_DIRECT`, `DEV_SUPABASE_SERVICE_ROLE_KEY`, `DEV_CRON_SECRET`; запуск — `DATABASE_URL_DIRECT="$DEV_DATABASE_URL_DIRECT" DATABASE_URL=... pnpm --filter @oplati/db db:migrate` (shell-env имеет приоритет над `--env-file`). Локальная разработка (`pnpm dev`) тоже должна ходить в dev-БД, не в прод. Пайплайн: feature-ветка → push → Preview (dev-БД + dev-бот, smoke) → PR → CI (tests/typecheck/lint) → squash в `main` → прод. **Main защищён ruleset'ом `protectionOplatishka` (2026-07-18):** прямой push запрещён — только PR с зелёными required-чеками `Tests`/`Type Check`/`Lint` (approvals 0 — solo, сам себе аппрув GitHub не даёт); force-push и удаление ветки заблокированы. **После каждого мержа в `main` проверять, что Vercel создал Production-деплой** (`vercel ls` или дашборд): 2026-07-18 GitHub→Vercel вебхук потерял событие мержа PR #83 и прод деплоили вручную `vercel deploy --prod` (см. [`docs/incidents.md`](docs/incidents.md)). НЕ возвращать прод-секреты в Preview.

**Vercel Deployment Protection: Disabled** — иначе Telegram получает `401` от обвязки Vercel до нашего кода. Защита — secret-token (`/api/bot`), подпись (L&P webhook), `X-Internal-Token` (внутренние endpoints), Supabase RLS.

### Доступ сайта из РФ без VPN — реверс-прокси на российском VPS (прод переведён 2026-07-22)

РКН/ТСПУ блокирует IP-диапазоны Vercel и дросселирует Cloudflare у мобильных операторов РФ (h3/ECH + обрыв соединения после ~16 КБ) — `oplatishka.com` без VPN не открывался. Проверено живьём: Cloudflare-проксирование (оранжевое облако + off ECH/HTTP3) **не помогло** для Мегафона — CF сам под дросселем. Рабочее решение — **reverse-proxy через российский VPS** (Timeweb, Москва, `104.171.133.70`, пинг 1–3 мс из РФ): для пользователя это обычный РФ-сайт, ТСПУ его не трогает.

**Статус: ПРОД переведён (владелец подтвердил доступ из РФ без VPN со стилями).** `www.oplatishka.com` и `oplatishka.com` — CF DNS → A-запись на Timeweb `104.171.133.70` (серое облако, DNS only; NS домена = Cloudflare). Цепочка на Timeweb (Dokploy/Traefik, overlay swarm): `клиент → Traefik (443, TLS/ACME Let's Encrypt) → Caddy-sidecar oplatishka-proxy → Vercel`. Конфиги на VPS (не через Dokploy UI): `/etc/dokploy/traefik/dynamic/oplatishka.yml` (роутеры www/apex/beta + middleware `oplatishka-strip-altsvc`) + `/opt/oplatishka-proxy/Caddyfile`. `beta.oplatishka.com` оставлен как тестовый алиас. Оферта Timeweb Cloud (VPS) reverse-proxy собственного сайта не запрещает (в отличие от их же виртуального хостинга); домен не в реестрах РКН.

**Три подводных камня перевода (решены, не повторять ошибки):**
1. **Vercel Firewall System Mitigations** включил bot-challenge (`x-vercel-mitigated: challenge`, 403) на весь домен — весь трафик идёт с одного IP (Timeweb) и выглядит как атака. Решение: **Timeweb IP в System Bypass** (`vercel firewall system-bypass add 104.171.133.70 --yes`) — обязательная часть схемы, без неё прокси душится. Attack Mode при этом Off (challenge — от авто-митигаций).
2. **Caddy connection-pool SNI-mismatch:** при разных SNI на общий upstream `cname.vercel-dns.com` Caddy переиспользует TLS-соединение с чужим SNI → Vercel отдаёт плавающие 403. Решение — **единый Host/SNI = `www.oplatishka.com`** для всех доменов в Caddyfile (apex видит www-контент без 308 — приемлемо).
3. **Alt-Svc (HTTP/3):** Traefik рекламировал h3 → браузер на повторном заходе пробует QUIC, который ТСПУ режет. Снято middleware `oplatishka-strip-altsvc` (customResponseHeaders `Alt-Svc: ""`) на наших роутерах.

**Клиентский IP за прокси (критично для rate-limit).** Эмпирически: Vercel затирает `x-real-ip`/`x-forwarded-for` IP-адресом соединения (= IP прокси), поэтому per-IP лимит схлопнул бы всех в один IP. Caddy кладёт реальный IP клиента в `X-Client-IP` (через `{client_ip}` c `trusted_proxies`) + секрет в `X-Proxy-Secret`; `getClientIp` читает `X-Client-IP` только при совпадении секрета `PROXY_SHARED_SECRET` (инвариант 9; задан в Vercel Production+Preview).

**Mini App-кабинет — НАПРЯМУЮ на Vercel, мимо прокси (2026-07-22).** Кабинет открывается только из Telegram (у РФ-пользователя VPN уже есть → `*.vercel.app` доступен), поэтому прокси ему не нужен, а лишний хоп РФ→Vercel лишь добавляет задержку. `miniAppUrl()` на production ведёт на `MINIAPP_BASE_URL` (`oplati-podpisku-web.vercel.app/cabinet`), `siteUrl()` остаётся на `APP_URL` (www) за прокси. Env не задан → fallback на APP_URL. **Второй вход — Direct Link в @BotFather** (Web App URL) — вести на тот же прямой vercel.app-домен (настройка владельца, не в коде).

**Денежный/ботовый путь изолирован от прокси:** self-call `payments/create` идёт через `VERCEL_URL` (собственный хост деплоя, мимо www); webhook L&P тогда указывал на `oplati-podpisku-web.vercel.app`. **Актуально на 2026-07-26:** в кабинете L&P ДВА активных вебхука — рабочий на `https://www.oplatishka.com/api/payments/loveandpay` (создан 24.07 при переезде) и легаси на preview-деплой ветки dev (последняя доставка 23.07, до cutover). Второй подлежит удалению владельцем; пока он жив, события уходят на оба адреса, поэтому у Vercel-проекта стоит WAF-правило `block-payments-after-dokploy-migration` (deny на `/api/payments/*`) — иначе старый деплой выпустил бы вторую карту. cron `poll-payment` дожимает потерянные вебхуки за ≤5 мин. Исходящие запросы В L&P шли через squid на `187.124.172.104` (удалён 2026-07-25 — см. выше, теперь прямой egress; при откате на Vercel поднять обратно). Смоук после перевода: заказ ORD-S3MGS создан чисто (order_created → payment_invoice_created, суммы консистентны). **Откат и хвосты — в [`docs/BACKLOG.md`](docs/BACKLOG.md).**

### Telegram-секреты (где что лежит, без значений)

> Реальные токены — только в Vercel env (Sensitive) и локальном `.env.local`/`.env` (gitignored). Никогда не пастовать в файлы, коммиты, чат. Компрометация: `/revoke` у `@BotFather`, `openssl rand -hex 32` для нового webhook-secret.

| Бот | Vercel env (по окружениям) | Локально |
|---|---|---|
| `@oplatishkaa_bot` (prod; до 2026-07-03 — `@test_prodipsa_bot`) | Production: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` |
| `@dev_test_podpiska_bot` (dev) | Preview: те же имена, dev-значения | `TELEGRAM_BOT_TOKEN_DEV`, `TELEGRAM_WEBHOOK_SECRET_DEV` |

Остальные env (Supabase, Anthropic, APP_URL, Love&Pay) — общие для обоих окружений. **Vercel `Sensitive`-флаг:** `vercel env pull` отдаёт пустую строку — by design; аудит по бейджу «Updated» в UI. После смены секрета **обязателен redeploy** — старые деплои держат стейл значение и отвечают `401`.

**Webhook у бота один.** Смена preview-URL → перерегистрировать webhook dev-бота; после merge — `deleteWebhook`. Без раскрытия токена: `POST/GET/DELETE /api/admin/telegram-webhook` (защита `X-Internal-Token`).

## Конвенции кода

- **`strict: true`** + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`. `any` запрещён; `unknown` + Zod narrow.
- **Never swallow errors** — `catch {}` и `catch { console.log }` запрещены: либо re-throw, либо `Sentry.captureException` + structured error.
- **Result pattern** для ожидаемых неудач (`{ ok: false, reason }`); `throw` — для неожиданного.
- **`console.log` запрещён** в production-коде — только `logger.*` (pino). PAN/CVC/токены не логируются никогда.
- **`fetch` без timeout запрещён** — всегда `AbortController`.
- **Именование:** `camelCase` функции, `PascalCase` типы/классы, `UPPER_SNAKE_CASE` compile-time константы, `snake_case` БД, `kebab-case.ts` файлы, `PascalCase.tsx` компоненты.
- **Commits — Conventional Commits** (`feat(agent):`, `fix(payments):`); squash merge; заголовок ≤ 72 символа.
- **RSC по умолчанию**, `"use client"` — только где нужен браузерный API.
- Graceful degradation на внешних зависимостях (Anthropic, БД): понятный ответ пользователю, не 500.

## MCP-серверы

`.mcp.json`: `github`, `filesystem`, `chromeDevtools`, `playwright`.

**Dokploy MCP вернулся 2026-07-28** — но НЕ в `.mcp.json`, а в **local scope**
(`~/.claude.json`, мимо git: репозиторий публичный, а нужны API-ключ и пароль
basic-auth). Возражение, из-за которого его убирали 27.07 («умеет только
`x-api-key`, значит пришлось бы открыть `/api` наружу»), снято переменной
`DOKPLOY_CUSTOM_HEADERS`: в ней едет `Authorization: Basic …`, поэтому проходятся
ОБА барьера, а `/api` остаётся закрытым. Проверено живым вызовом:
`x-api-key` без basic-auth снаружи получает `401` от Traefik.

Управление контуром без MCP (и как fallback) — ssh + API с самого VPS:
```bash
ssh root@187.124.172.104 'curl -s -H "x-api-key: <ключ>" http://127.0.0.1:3000/api/project.all'
```
На `127.0.0.1:3000` запрос идёт мимо Traefik, поэтому basic-auth не участвует.

⚠️ **Правка env через API перезаписывает его ЦЕЛИКОМ**, `saveEnvironment` требует
ещё `buildArgs`/`buildSecrets`/`createEnvFile` (иначе `400`), а в БД панели env
лежит зашифрованным. Порядок с бэкапом и построчной сверкой — в
[`docs/runbooks/deploy.md`](docs/runbooks/deploy.md).

**Supabase MCP убран 2026-07-25:** боевая БД — self-hosted Postgres на VPS, и MCP туда не ходил; оставленный, он выглядел как доступ к проду, а отдавал данные холодного резерва. Запрос к боевой БД — через ssh:
```bash
ssh root@187.124.172.104 'docker exec $(docker ps --filter name=oplatishka-db-ry3smb -q) \
  psql -U oplatishka -d oplatishka -c "select count(*) from orders"'
```
Резерв Supabase (`nyxijwpuvctmvemaemqn`, данные на момент cutover) при необходимости смотреть через его дашборд — см. [`docs/runbooks/rollback.md`](docs/runbooks/rollback.md). Миграции — только через Drizzle, ни через MCP, ни руками.

## Что запрещено

- Кросс-импорты между `apps/*`, циклы между пакетами, импорт приватных путей пакетов.
- `pnpm --filter @oplati/db db:push --force` на prod.
- Commit `.env*` / реальных токенов (`.gitignore` покрывает — не отключать).
- Использовать prod Supabase / Telegram-бот / кабинет Love&Pay для локальной разработки.
- Эмодзи в коде, комментариях, логах (в русских UI-строках — можно, если требует продукт).
- Логировать или сохранять полные PAN/CVC карт.
- Выдумывать контракт внешнего API (PaySpace, L&P, Rapira) — только подтверждённый живым вызовом или докой владельца.
