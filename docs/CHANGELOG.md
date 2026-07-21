# Changelog

Все заметные изменения проекта. Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), секции по датам milestone'ов (semver-версии пока не выпускаются, `package.json` остаётся `0.0.1` до публичного релиза).

Подробный старый changelog (велся до 2026-06-10) — в истории git: `git show d9a1cb3:CHANGELOG.md`.

---

## 2026-07-21 — VPN Оплатишки: кнопка «VPN» в боте (Remnawave)

### Added

- Кнопка «🛡 VPN» в /start-меню бота выдаёт персональную ссылку-подписку
  Remnawave (`panel.mxpkn8ns.ru`): юзер панели создаётся по telegramId
  (username `tg_<id>`, срок +1 календарный месяц, Default-Squad, трафик
  200 ГБ/мес), клиенту уходит ссылка в `<code>` + пошаговая инструкция Happ
  (при первой выдаче — альбом скриншотов, кнопки App Store / Google Play).
- Повторное нажатие возвращает ТУ ЖЕ ссылку (идемпотентность: снимок в БД →
  `by-telegram-id` в панели → создание). Кнопка «Обновить ссылку»
  (`vpn:refresh`) перевыпускает её через `actions/revoke` — старая умирает
  сразу, срок НЕ продлевается; юзера панели удалили вручную (404) → выпуск заново.
- Новая таблица `vpn_subscriptions` (миграция 0024; RLS deny-by-default,
  unique по user_id / telegram_id / remnawave_uuid) + репозиторий upsert.
- Клиент `lib/remnawave/` (Bearer server-side, timeout 10s, без ретраев),
  Zod-контракт `@oplati/types` — подтверждён живыми вызовами (create 201 /
  by-telegram-id 200+`[]` / revoke меняет shortUuid / delete `isDeleted`);
  справочник — `docs/remnawave-api.md`. env: `REMNAWAVE_API_TOKEN`
  (Sensitive, prod+preview), `REMNAWAVE_BASE_URL` / `REMNAWAVE_SQUAD_UUID` /
  `REMNAWAVE_TRAFFIC_LIMIT_GB`.
- Тесты: types +5 (контракт), web +18 (клиент, `addOneMonthUtc` с клампом
  конца месяца, HTML-шаблон), db +2 (PGlite upsert-снимок).
  Продление VPN по оплате (L&P) — осознанно следующий этап.

---

## 2026-07-19 — Волна аудита: M-11…M-15 + LOW-чистка (L-2…L-20)

Одной веткой (3 фазы, каждая с ревью и полным сьютом; web 401 / types 105 / db 30).

### Fixed

- **M-14**: запасной курс USDT→RUB при недоступной Rapira поднят 77 → 81 ₽.
- **M-15**: telegram_id владельца удалён из кода — получатель поддержки только
  из env (`SUPPORT_OPERATOR_CHAT_ID` задан на prod+preview); не задан → Sentry.
- **L-4**: при захоронении просроченного заказа клеймится и его pending-платёж.
- **L-5**: `payOrder` отдаёт ссылку строго живого (pending) инвойса.
- **L-6**: таймаут `POST /invoices` L&P больше не ретраится (риск двойного счёта).
- **L-10**: «Действует до» карты — реальный `exp_date` из PaySpace (fallback 180д).

### Changed

- **M-11**: позы маскота PNG (2.16 MB) → WebP (310 KB), `ASSET_VERSION=3`.
- **M-12**: миграция 0023 — частичные индексы под кроны renewal-reminder и
  referral-recovery (`orders.fulfilled_at WHERE completed`, `orders.paid_at`).
- **M-13**: новый cron `retention` (04:15) — переписка старше 90 дней удаляется,
  `payments.raw_payload` старше 180 дней очищается; `order_events` не трогаются.
- **L-9**: мёртвые actions `repeat`/`operator` удалены из `/api/cabinet`.
- **L-20**: callback тарифа — стабильный ключ `period:usdCents` вместо индекса.
- Чистка: L-3 (markActive), L-7/8 (доки/stderr), L-11 (env.server), L-12
  (tool-cards.ts), L-13 (единый formatUsd), L-15/16 (мёртвые env/экспорты),
  L-17 (смоук-скрипты помечены устаревшими), L-18 (мусор в корне), L-19
  (GitHub Action пинг dev-Supabase), **L-14: тесты включены в `pnpm typecheck`**.
- Тесты: +T-1 (repeat_confirm/23505/storedInvoice), +T-3 (expire-payments),
  +T-4 (payOrder/extractInvoiceLink), retention, поддержка без оператора.
- Пост-ревью волны (независимый ревьюер): восстановлен алёрт «оплата пришла по
  захороненному счёту» (`paid_after_terminal` → DM + Sentry; регресс L-4),
  срок карты — конец месяца по Москве (20:59:59Z), fail-fast на дубль ключа
  тарифа в seed (L-20), реальный telegram_id владельца убран из тестовых фикстур.
- Документация прибрана: живая справка в `docs/`, история (старые планы,
  отчёты аудитов, мокапы) — в `docs/history/`; новый `docs/BACKLOG.md` с
  отложенными задачами (CSP enforce, внешний мониторинг VPS, E2/E3 рефералки,
  VCC-preflight, forum-topics).

---

## 2026-07-19 — Понятное уведомление об истёкшем заказе + фикс ложных алёртов прокси

### Fixed

- **Ложные «КРИТИЧНО: прокси L&P не отвечает»**: origin `loveandpay.io` стал
  отвечать 307-цепочкой, healthcheck ходил по редиректам до лимита и считал
  живой прокси лежащим (19 ложных событий за ночь, 3 DM владельцу). Теперь
  `redirect: 'manual'`: любой HTTP-ответ, включая 3xx, = прокси жив.
  Разбор — в `docs/incidents.md`.

### Changed

- **Уведомление «срок оплаты истёк»** (cron `expire-payments`) вместо
  внутреннего номера ORD-XXXXX называет сервис, сумму и дату оформления:
  «Срок оплаты истёк: ChatGPT Plus на 2 456 ₽, оформлен 19 июля…»
  (`buildOrderExpiredMessage` в templates.ts + тесты).

---

## 2026-07-19 — AI-диалог сайта за флагом WEB_AI_ENABLED

### Changed

- **Переписка на сайте выключена по умолчанию** (решение владельца): покупка
  кнопочная, диалог в воронке не участвует. `/api/chat` при выключенном
  `WEB_AI_ENABLED` отвечает мгновенной заготовкой (каталог/поддержка) без
  вызова Anthropic и записей в БД; UI не меняется. `'1'`/`'true'` возвращает
  AI-диалог — код агента цел (образец: `BOT_AI_ENABLED`). Route-тест на оба
  состояния флага.

---

## 2026-07-19 — Аудит: MEDIUM-волна 2 — суммы, таймауты, типы, распил бота

Закрытие M-5…M-10 из fix-plan аудита (PR #88; поведенческие — по Prove-It).

### Fixed

- **M-5 — «1,000» парсилась как $1**: в custom-amount флоу бота запятая с
  тремя цифрами после теперь распознаётся как разделитель тысяч
  (`1,000`→$1000, `1,000.50`→$1000.50); `19,99`/`1,5` остаются десятичными;
  двусмысленные `1,00` и европейский `1.000,50` — invalid (бот переспросит).
- **M-6 — таймаут убивал функцию посреди оплаты**: `maxDuration=90` у
  `/api/chat` и `/api/bot` (self-call `payments/create` теперь с таймаутом
  45с и гарантированно завершается раньше вызывающей функции).
- **M-7 — битая `pricing_policy` открывала клиентскую цену**: невалидная
  запись каталога у тарифного сервиса → отказ `service_unavailable`
  (HTTP 503) + Sentry-алерт; custom-amount — только по явному маркеру.

### Changed

- **M-8**: tool-loop агента типизирован — `satisfies`-реестр Zod-схем
  (компилятор форсит полноту и совпадение типов), switch-диспатч вместо
  `(handler as any)`; несуществующий tool от модели → `is_error`.
- **M-9**: `partner-api.ts` парсит ответы `/api/cabinet/referral` Zod-схемами
  из общего `lib/cabinet/referral-api-schemas.ts` (привязаны к
  `ReferralSnapshot` через `satisfies`) вместо `as`-кастов.
- **M-10**: `handle-update.ts` (1726 строк) распилен по флоу — `persist`,
  `send`, `start-menu`, `link-flow`, `support-flow`, `catalog-callbacks`,
  `agent-dialog` + тонкий роутер (350 строк); поведение 1:1.

---

## 2026-07-18 — Аудит: MEDIUM-волна — рефералка, транзакция оплаты, недоплата

Закрытие M-1/M-2/M-3 из fix-plan аудита (все — по Prove-It).

### Fixed

- **M-1 — цикл в реферальном дереве**: `setReferrerOnce` теперь проверяет, что
  кандидат-реферер не является потомком пользователя в дереве `referred_by`
  (обход вверх, кап 16, fail-closed) — исключён взаимный фарм комиссии A↔B;
  новый reason `'cycle'`, PGlite-тесты на прямой и транзитивный цикл.
- **M-2 — атомарность выставления счёта**: в `payments/create` запись платежа,
  переход заказа в `pending_payment` и выравнивание срока идут в одной
  транзакции — сбой БД больше не оставляет живой L&P-инвойс при заказе в
  `ready_for_payment`. Route-тест (первый для этого эндпоинта, часть T-1) +
  PGlite-регресс отката.
- **M-3 — терминальный путь недоплаты**: `amount_mismatch` переводит платёж в
  `failed` и заказ в `failed` (событие `payment_amount_mismatch`), владельцу
  уходит РОВНО один DM «нужен ручной возврат» (повторы дедуплицируются
  атомарным claim'ом); исчез 25-часовой ре-алерт poll'а и захоронение частично
  оплаченного заказа как «срок истёк».

### Changed

- Тесты: web 346 → 350, db (PGlite) 24 → 28.

## 2026-07-18 — Аудит: закрытие HIGH-находок + сроки оплаты 2ч/1ч

Полный аудит проекта (6 осей, весь репозиторий; ТЗ по всем находкам —
`docs/audit-2026-07-18-fix-plan.md`). BLOCKER'ов нет; три HIGH закрыты сразу, все
фиксы по Prove-It (падающий тест → фикс → зелёный сьют).

### Fixed

- **H-1 — вечный 400 Anthropic в чате**: окно истории `loadRecentMessages(…, 20)`
  могло начаться с `assistant`-записи (непарные записи реальны: пустой ответ не
  персистится, support-callback пишет только assistant) → Messages API отвечал 400
  на каждый ход без самолечения. `toAgentHistory` теперь отрезает ведущие
  `assistant`; дубль функции в `handle-update.ts` удалён — оба канала используют
  общий `lib/chat/history.ts`.
- **H-2 — фиксация цены не форсилась сервером**: черновик `ready_for_payment` жил
  вечно и оставался оплатимым по устаревшему курсу. Добавлен переход
  `ready_for_payment → expired` в state machine; cron `expire-payments` хоронит оба
  оплатимых статуса (`findExpiredPayableOrders`); гейт `isPriceLockExpired` в
  `payments/create` закрывает окно между прогонами cron (`409 order_expired`).
- **M-4 — рассинхрон TTL заказа и инвойса**: при выставлении счёта
  `orders.expires_at` выравнивается по сроку инвойса L&P (`setOrderExpiresAt`) —
  cron больше не может похоронить заказ при живом инвойсе.

### Added

- **H-3 — мониторинг SPOF-прокси L&P** (`lib/jobs/proxy-health.ts`): cron
  `poll-payment` каждые 5 мин проверяет CONNECT через squid; падение → Sentry
  `lnp_proxy_down` + DM владельцу (дедуп 60 мин). Операционная часть (резервный
  IP, внешний uptime-мониторинг) — за владельцем, см. fix-plan.
- **«Тех. сбой» для пользователей**: классификатор `isPaymentProviderUnavailable`
  (сетевой сбой / таймаут / 5xx-429 L&P после ретраев) → `503 provider_unavailable`
  → все каналы (веб-кнопка, Mini App-кабинет, AI-чат) показывают «Оплата временно
  недоступна — технический сбой. Заказ сохранён, попробуй позже» вместо
  generic-ошибки; healthcheck прокси запускается сразу через `after()`.

### Changed

- **Сроки оплаты (решение владельца)**: фиксация цены черновика — **2 часа**
  (было 24: суточный односторонний опцион на курс за счёт маржи), счёт L&P —
  **1 час** (было 24; СБП/карта оплачиваются за минуты). Просроченный черновик
  переоформляется по свежему курсу за полминуты.
- Тесты: web 320 → 346, types 104 → 105, db (PGlite) 22 → 24.

## 2026-07-18 — Инфраструктура: dev-окружение Preview и защита main

Полноценный пайплайн feature → Preview → PR → main (PR #83, #84): Preview больше не делит данные с продом, main закрыт от прямых push.

### Added

- **Отдельная dev-Supabase для Preview и локальной разработки** (`oqwofyipeuzgezdplixn`, отдельный Supabase-аккаунт): применены все миграции (0001–0023) + seed каталога (13 активных сервисов). Vercel Preview env переведён на dev-значения: `DATABASE_URL`/`DATABASE_URL_DIRECT`/`SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`; добавлены `APP_URL` (фикс fail-fast preview-деплоев), отдельный `CRON_SECRET` и предохранитель `AI_DAILY_TOKEN_BUDGET=200000`.
- **Branch protection ruleset `protectionOplatishka` на `main`**: merge только через PR с зелёными required-чеками `Tests` / `Type Check` / `Lint`; force-push и удаление ветки заблокированы; approvals 0 (solo).

### Changed

- **AI на Preview/dev — Haiku**: основной агент на `claude-haiku-4-5-20251001`, прод остаётся на `claude-sonnet-4-6`; env-записи `ANTHROPIC_MODEL`, `SUPABASE_URL`/`SUPABASE_ANON_KEY` разделены по окружениям (раньше были общими с продом).

### Ops

- Инцидент: GitHub→Vercel вебхук потерял событие мержа PR #83 — прод задеплоен вручную (`vercel deploy --prod`); после каждого мержа проверять появление Production-деплоя (подробности — `docs/incidents.md`).

## 2026-07-18 — Улучшение клиентского пути (ТЗ: сайт · бот · Mini App)

Внедрение ТЗ «Улучшение клиентского пути» одним релизом (PR #81): клиент с первого экрана понимает ценность сервиса, видит полную цену до оплаты, получает пер-сервисную инструкцию и не теряется после выпуска карты.

### Added

- **Первый экран сайта** — УТП («Оплачивай зарубежные подписки рублями» + 3 галочки), кнопки «Выбрать сервис» / «Как это работает», подпись «Итоговую сумму увидишь до оплаты». Онбординг из трёх шагов с индикатором «N из 3» (`HowItWorksOverlay`); тексты онбордингов Mini App и веб-интро приведены к тем же шагам ($4 за первую карту, 180 дней).
- **Пер-сервисные правила оплаты** — `services.payment_instructions` (jsonb, миграция 0022; Zod `servicePaymentInstructions`: `requiresVpn`/`vpnLocation`/`requiredCurrency`/`billingInstructions`/`paymentUrl` (https-only)/`paymentNotes`). Seed заполняет 13 активных сервисов; блок «Важно перед оплатой» на карточке сервиса (сайт + Mini App) и экране заказа. VPN больше не общий совет; битая запись не прячет сервис (generic-fallback + warn в лог).
- **Экран карты в кабинете** — live-баланс из PaySpace (`getCardInfo`, бюджет 4 с; кэш в БД через compare-and-set `syncCardBalance`, не трогающий `last_used_at`), строки «Для оплаты: <сервис>» и «Действует до» (выпуск + 180 дней), кнопки «Перейти на сайт сервиса» / «Инструкция» / «Не проходит оплата?». Показанные реквизиты автоскрываются через 60 секунд.
- **Статусы после выпуска карты** — «Ожидает оплаты на сайте сервиса» / «Подписка оплачена» / «Возникла проблема» как производные от append-only событий `order_events` (`subscription_activated`/`payment_issue_reported`, решает последнее по времени; статус-машина заказа не тронута). Действия `/api/cabinet`: `payment-issue` (чек-лист самопроверки, выбор типа ошибки, автоконтекст оператору: заказ/сервис/тариф/сумма/статус карты/тип ошибки; дедуп 5 мин) и `subscription-paid` — оба с серверным гейтом `status='completed'`.

### Changed

- Кнопка оплаты содержит финальную сумму («Оплатить 2 490 ₽») в веб-чате и Mini App; добавлен раскрывающийся блок «Как рассчитана сумма» (цена $, зафиксированный курс, комиссия, разовый выпуск карты) и подпись «Цена зафиксирована до <expiresAt>».
- Страна выпуска карты убрана из всех публичных текстов — терминология «виртуальная карта».
- Доставка обращений оператору вынесена в общий `lib/telegram/support.ts` (бот `/support` + кабинет).

### Security

- PAN-подобные последовательности (12–19 цифр) в комментарии клиента к жалобе маскируются до отправки оператору (`redactCardNumbers`, остаются последние 4 цифры).
- `callCabinet` (Mini App) переведён на `fetchWithTimeout` (65 с) — конвенция «fetch без таймаута запрещён».

Тесты: web 320, types 104, db 22 (PGlite: CAS-гонка sync vs topup, контраст по `last_used_at`). Ревью перед merge: CodeRabbit (CLI + бот, 18 находок → исправлены подтверждённые, ложные отклонены с проверкой); Greptile недоступен (триал истёк).

## 2026-07-14 — Аварийный переход Telegram deep-links на `telegram.me`

### Fixed

- Из-за глобального `serverHold` домена `t.me` все пользовательские Telegram-ссылки
  переведены на официальный alias `telegram.me`: реферальные приглашения, привязка
  Telegram с сайта, Mini App, поддержка, канал, share-flow и Telegram Premium.
- Форматы payload не менялись: бот по-прежнему получает `/start ref_<code>` и
  `/start link_<token>`, а Mini App — `startapp=ref_<code>`.
- Генерация runtime-ссылок собрана в `lib/telegram/links.ts` и покрыта контрактными
  тестами, чтобы домен и параметры не расходились между пользовательскими потоками.

## 2026-07-14 — Возврат рыночного курса Rapira без надбавки

### Changed

- Отменена дополнительная надбавка 3,5% к `askPrice` Rapira. Формула снова: `USD × askPrice`, затем 30% комиссии и разовые `$4` по тому же курсу только при отсутствии активной карты.
- Аварийный `RATE_FALLBACK_USDT_RUB` также используется без дополнительной надбавки.

## 2026-07-14 — Курс Rapira вместо fallback Love&Pay

### Fixed

- Источник USDT/RUB для расчёта заказа и каталога переключён с неработающего `Love&Pay /rates` на публичный Rapira `GET /open/market/rates`. Используется `askPrice` пары `USDT/RUB`; ответ валидируется Zod, запрос ограничен таймаутом и не кэшируется.
- Формула подтверждена тестами: `USD × курс + 30%`, затем разовые `$4` за выпуск только при отсутствии активной карты. Love&Pay остаётся без изменений как провайдер RUB-инвойсов.

## 2026-07-10 — Кнопка «Личный кабинет» на сайте, канал в меню бота

### Changed

- **Панель профиля (сайт):** кнопка «Telegram» (вела просто в бота) заменена на **«Личный кабинет»** — она появляется только после привязки Telegram и ведёт в Mini App. Ссылку отдаёт `/api/profile` полем `cabinetUrl` (`cabinetDeepLink()` в новом `lib/telegram/deep-links.ts`): при заданном `TELEGRAM_MINIAPP_SHORTNAME` — прямой `t.me/<bot>/<shortname>` (кабинет одним тапом), иначе fallback `t.me/<bot>?start=cabinet` (в /start-меню есть web_app-кнопка). Из браузера web_app-кнопку открыть нельзя — только через Telegram.
- **Аватар в профиле убран** — остаётся имя из Telegram. У веб-сессии нет `initData`, а тянуть фото через Bot API (`getUserProfilePhotos` + `getFile` + прокси, т.к. URL файла содержит токен бота) ради кружка признано неоправданным.
- **Кнопка «Telegram-канал»** в /start-меню бота стала настоящей url-кнопкой на `t.me/ooplatishka` (канал создан) вместо callback-заглушки. Callback `channel` оставлен: старые отправленные меню отвечают ссылкой на канал.

### Added

- Флаг `REFERRAL_MINIAPP_DEEPLINK` (дефолт `false`). Раньше формат реф-ссылки был завязан на `TELEGRAM_MINIAPP_SHORTNAME`, и задание short name ради кнопки кабинета молча переключило бы приглашение с bot-контекста (`?start=ref_`) на `?startapp=ref_`. Теперь short name — факт регистрации приложения, а формат реф-ссылки — отдельное решение (`referralMiniAppShortName()`).

---

## 2026-07-08 — Аудит безопасности: 14 находок закрыты (2 HIGH + 6 MEDIUM + 6 LOW)

Многоагентный аудит всей кодовой базы (19 зон × осей: безопасность / платежи-деньги-идемпотентность / RLS-PII / корректность / тесты; адверсариальная верификация каждой находки). Платёжное ядро держалось — **0 BLOCKER**; исправлены дефекты на периферии. PR #66 (HIGH+MEDIUM) + #67 (LOW), оба на Production (Vercel MCP подтвердил READY).

### Security

- **H1 — полный PAN/CVV мог утечь в логи/Sentry.** `PaySpaceContractError.rawBody` (сырое тело card-эндпоинтов) при дрейфе контракта попадал в `log.error({ err })` / `captureException`. Свойство сделано неперечисляемым (`Object.defineProperty enumerable:false`) — pino/Sentry его не сериализуют; в `logger.ts` добавлен redact `err.rawBody`/`*.rawBody` вторым слоем.
- **M3 — обход rate-limit спуфингом (CWE-348).** `getClientIp` (`ratelimit.ts`) больше не доверяет левому `x-forwarded-for` (клиент подделывает на Vercel) — приоритет неподделываемого `x-real-ip`, `xff` только fallback (правый элемент). Иначе ротация заголовка обнуляла per-IP лимит на 4 эндпоинтах.
- **M1/M2 — cost-DoS через создание `users`.** `GET /api/orders/status` стал read-only (`readWebSessionId`+`findUserIdByWebSessionId`, пользователя не создаёт) + rate-limit по IP; `POST /api/cabinet/referral` и `/api/chat/clear` (L1) получили IP-барьер ДО записей в БД.
- **L6 — Zod на входах AI-tools.** Сырой `tool_use.input` парсится схемами (`searchCatalog/proposeOrder/confirmOrder/requestHumanInput` в `@oplati/types`, `.max()` на строках) ДО обработчика; провал → `is_error`. Устаревшая `proposeOrderInput` переписана под контракт `ToolHandlers`.

### Fixed

- **H2 — двойной выпуск карты.** `createCard` (единственная мутирующая операция PaySpace без `request_id`) ретраился на таймаут/5xx → повтор выпускал вторую профинансированную карту-призрак (потеря funding + $4). Помечен `idempotent:false` — не ретраится.
- **M4 — TOCTOU статуса платежа.** `markPaymentStatus` (безусловный UPDATE) мог перезаписать `succeeded→failed` при конкурентной доставке `invoice.paid`+`invoice.expired`. Заменён атомарным `claimPaymentTerminal` (условный `pending→failed`, null-возврат = idempotent_skip); `markPaymentStatus` удалён.
- **M5 — застрявший VCC-фонд.** `idleAgedActiveCards` фильтровал по `last_used_at < now()-90d`, но у живых карт он `NULL` (`NULL < ts` = NULL) → карты не идлились → не доходили до `release`. Простой меряем от `COALESCE(last_used_at, created_at)`; `updateBalance` (топ-ап) проставляет `last_used_at`.
- **M6 — дубли напоминаний о продлении.** Окно выборки (3 дня) шире шага крона (сутки) → 3-4 одинаковых сообщения. `findOrdersForRenewalReminder` исключает заказы с событием `renewal_reminder_sent` (`NOT EXISTS`); новая `appendOrderEvent` пишет это событие после отправки.
- **L2 — `createDraftOrder`** оборачивает INSERT `orders` + `order_created` в одну транзакцию (append-only атомарность A1/A4).
- **L3 — комментарий state-machine** приведён к коду (`failed`/`completed` квази-терминальны → `refund_requested`, а не «пустой массив»).
- **L4 — `Number(telegramId)`** терял точность на больших 64-битных chat_id → передаём строкой (`expire-payments`, `renewal-reminder`).
- **L5 — реквизиты новой карты** отправляются ПОСЛЕ `transitionOrder(completed)` best-effort: сбой доставки больше не откатывает выполненный заказ в `failed` и не шлёт ложный ops-алёрт «не доставлен».

### Ops

- Тесты: web 238→252, types 87→95, db 15→18 (+19 регрессов на находки, включая PGlite-тест `idleAgedActiveCards` на `NULL last_used_at`). Typecheck + lint чисто. PR #66/#67 squash в `main`, Production READY.
- Скил `/full-review` (`.claude/skills/full-review/`) — проектный чеклист инвариантов (CLAUDE.md) для точечного ревью веток/PR параллельными саб-агентами по осям.
- **Не входит в аудит кода:** 11 dependabot-уязвимостей (4 critical) в зависимостях — отдельная задача.

## 2026-07-03 — Надбавка за карту в цене, выключатель AI-чата бота, домен oplatishka.com, чистка UI

### Added

- **Надбавка за выпуск карты в цене клиента** (`CARD_ISSUE_FEE_USD_CENTS`, на проде $4=400 центов): берётся только когда у клиента нет активной карты (`findActiveByUserId` — первая покупка; при повторной топап без fee). Снимок `orders.card_issue_fee_kopecks` (миграция `0019`). Экран заказа — построчная разбивка «Подписка / Выпуск карты / Итого», при повторной «Карта уже есть». `+3` теста расчёта + `2` PGlite-теста персистентности (юнит-моки `createDraftOrder` скрывали баг — поле не писалось в `.values()` INSERT, поймал CodeRabbit).
- **Реф-ссылка в главном меню Mini App** — карточка «Скопировать»/«Поделиться» (fallback `execCommand` под Telegram WebView, где `navigator.clipboard` блокируется); поле `referralLink` в снапшоте `/api/cabinet` за `REFERRAL_ENABLED`.
- **Набор SVG-иконок комикс-стиля** (`components/comic/icons.tsx`, 18 шт.) вместо эмодзи по кабинету и партнёрке; «Оплатить подписку» → «Выбрать сервис», «В кабинет» → стрелка.
- **Выключатель `BOT_AI_ENABLED`** (дефолт выключено): бот в чате не реагирует на сообщения (текст/медиа/каталожные кнопки/`/menu` — молчит), работают только команды `/start`/`/support` и inline-меню; покупки/диалог — в Mini App. Код каталога и AI-агента сохранён (`BOT_AI_ENABLED=1` возвращает прежнее поведение) — временный выключатель, не удаление.
- **Кнопка «🌐 Сайт»** в inline-меню `/start` (url на главный сайт; `siteUrl()`/`deploymentBaseUrl()`).

### Changed

- **Домен → `https://www.oplatishka.com`** (custom подключён, env `APP_URL`). От него резолвятся Mini App `/cabinet`, кнопка «Сайт», презентация партнёрки, payment deep-link, self-call — хардкодов домена в коде нет. Дефолтный `oplati-podpisku-web.vercel.app` тоже обслуживает.
- **Стартовое сообщение (`GREETING`) переписано** — короткое, дружелюбное; убраны USDT (не принимаем), «оператор вручную», «напиши, что нужно» (AI-чат в боте выключен → бот молчит), отклонённые сервисы (Disney+/Notion/Figma/GitHub), двойные тире. `SYSTEM_PROMPT` (веб-чат AI) — тоже без USDT/«оператор вручную».
- **Экран заказа** — убраны «Повторить заказ» и «Нужен оператор» (операторов нет, повтор не нужен); осталась только «Оплатить». Почищен мёртвый `doRepeat`/`doOperator`/`operatorResultSchema` (`RepeatResult` → `OrderCreationResult`).
- **Кнопка «Поддержка» на сайте → «Telegram»** (`ProfilePanel`); ссылка deep-link `?start=site` → бот открывается на `/start` (приветствие + меню), а не на неработающем `/menu`.
- **`setMyCommands` — только `/support`** (`/menu` убран, не работает при выключенном `BOT_AI_ENABLED`).
- **Починена презентация партнёрки** в узком вьюпорте Telegram (`public/partner-presentation.html`: `100dvh` вместо `100vh`, мягкий/выключенный scroll-snap, `min-width:0`, перенос широких блоков — `<code>`, ASCII-схема).

### Ops

- Миграция `0019` (`orders.card_issue_fee_kopecks`, nullable) применена на прод; env `CARD_ISSUE_FEE_USD_CENTS=400` и `APP_URL=https://www.oplatishka.com` заданы на Production + redeploy. Все изменения задеплоены (PR #51–#54, ревью Greptile + CodeRabbit).

## 2026-07-02 — Mini App каталог + `/start`-меню + реферальный захват (2 канала) + фикс Date-бага

### Fixed

- **Реферальный захват падал с самого запуска программы (критично, prod).** `getOrCreateUserBy{TelegramId,WebSessionId}` передавали `referred_by_set_at` как JS `new Date()` в raw-`db.execute` — слой кэша запросов не хешит `Date` и ронял весь `INSERT`, но ТОЛЬКО когда реферер задан (иначе `null`, без Date). Итог: обычный `/start` писался, а `/start ref_` падал → новый юзер не создавался с реферером → далее заходил в приложение, где строка создавалась без привязки → `referred_by` вечно `null`; ни одно реферальное начисление не проходило. Диагностика по прод-логам `/api/bot`: `telegram.referral.captured` (реферер определён верно) → `telegram.persist.failed` `The "string" argument must be ... Received an instance of Date`. Фикс: `new Date()` → SQL `now()` в обоих upsert'ах. Регресс-тест на PGlite (`getOrCreateUserByTelegramId` с `referredBy` ставит `referred_by` + `referred_by_set_at`).

### Added

- **Кнопочный каталог внутри Mini App** (`components/cabinet/CatalogView.tsx`): «Оплатить подписку» → выбор сервиса → тариф/сумма → заказ → экран заказа с «Оплатить». Новый action `propose` в `POST /api/cabinet` (`proposeNewOrder` → общий `proposeFromCatalog`, channel `telegram`; цена строго серверная, auth по `initData`).
- **Реферальный захват из Mini App** (`lib/cabinet/referral-capture.ts`): `initData.start_param` (`?startapp=ref_<code>`, входит в подписанную `data_check_string` — доверяем после проверки подписи) → `setReferrerOnce` с анти-абьюз-гейтом `hasPurchasedOrders`; плюс поздний захват на повторном `/start ref_` для уже существующих строк (напр. созданных мини-аппом). Env `TELEGRAM_MINIAPP_SHORTNAME` (опц.) переключает ссылку-приглашение кабинета на прямой Mini App-link.

### Changed

- **`/start` бота — inline-меню** (`buildStartMenuKeyboard`) вместо постоянной reply-клавиатуры: web_app «Открыть приложение» (prod `APP_URL` / preview `VERCEL_URL`), «Поддержка», заглушка-мок «Telegram-канал» (`callback channel`). Тексты старых reply-кнопок ещё перехватываются для существующих пользователей.
- **Список заказов (история покупок) в кабинете удалён** (`OrderRow.tsx` удалён) — кабинет = «оплатить подписку» + карта + партнёрка; снапшот `orders` бэкенд отдаёт, UI не рендерит.
- **Ссылка-приглашение вернулась на bot deep-link** `t.me/<bot>?start=ref_<code>` — `TELEGRAM_MINIAPP_SHORTNAME` снят с прода (владелец предпочёл контекст бота: друг видит «Оплатишку», а не голый mini app).

### Ops

- Mini App `pay` зарегистрирован в BotFather (`/newapp` → `t.me/test_prodipsa_bot/pay`, фото 640×360). Menu Button (☰) отключён — чтобы приглашённый не заходил в приложение мимо реф-кода. Восстановлены реферальные привязки, потерянные из-за Date-бага (бэкфилл `referred_by` тестовых заходов).

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
