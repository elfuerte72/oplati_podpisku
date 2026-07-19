# ТЗ по правкам аудита 2026-07-18

Источник — полный аудит проекта (6 осей, весь репозиторий, файлы целиком). Этот файл —
рабочее ТЗ для агентов, которые будут закрывать находки. Правила:

- **Каждый фикс — по Prove-It:** сначала падающий тест, воспроизводящий баг → фикс →
  тест зелёный → полный прогон сьюта пакета (`pnpm --filter web test`,
  `pnpm --filter @oplati/types test`, `pnpm --filter @oplati/db test`) + `pnpm typecheck`.
- Не нарушать архитектурные инварианты CLAUDE.md (append-only `order_events`,
  `transitionOrder()`, деньги integer, Zod на границах, webhook 200 OK и т.д.).
- Один фикс (или связная группа) = одна feature-ветка → Preview smoke → PR → squash в `main`.
- После фикса — обновить статус здесь (`[ ]` → `[x]` + PR#).

Severity — из аудита. BLOCKER'ов нет. Оси независимы, между осями не переранжируются.

---

## HIGH (приоритет 1)

### [x] H-1 (ось E) — история чата может начаться с assistant → перманентный 400 Anthropic

- **Где:** `apps/web/lib/chat/history.ts:14` + дубль `apps/web/lib/telegram/handle-update.ts:1673`.
- **В чём баг:** `loadRecentMessages(…, 20)` берёт последние 20 строк истории. Окно может
  начаться с `assistant`-записи. `toAgentHistory` схлопывает соседние одинаковые роли и
  гарантирует, что ПОСЛЕДНЕЕ сообщение — `user`, но НЕ гарантирует, что ПЕРВОЕ — `user`.
  Anthropic Messages API требует первую роль `user` → 400 «first message must use the user role».
- **Почему навсегда:** каждый ход добавляет 2 записи (user + assistant) — чётность окна
  сохраняется, сдвиг не лечит. Непарные записи реальны: пустой ответ агента не персистится
  (`chat/route.ts` — user остаётся без пары), support-callback пишет только assistant,
  сбой одного `safeAppendMessage`.
- **Как проявляется:** диалог >20 сообщений с одной непарной записью → каждый следующий
  ход = 400 → пользователь вечно получает AI_DOWN_TEXT в обоих каналах.
- **Фикс:** в `toAgentHistory` после схлопывания отрезать ведущие `assistant`-элементы
  (после collapse их максимум один). Дедуплицировать: удалить локальную копию из
  `handle-update.ts`, импортировать общий `toAgentHistory` из `@/lib/chat/history`
  (устраняет drift-риск, отмеченный аудитом).
- **Тесты:** `apps/web/lib/chat/history.test.ts` — окно, начинающееся с assistant → первый
  элемент user; пустая история; collapse same-role; operator→assistant; последний — user.
- **Статус:** сделано в этом сеансе (см. коммит/PR ветки фикса).

### [x] H-2 (ось B) — `ready_for_payment` никогда не экспайрится: «фиксация цены» не форсится

- **Где:** `apps/web/app/api/payments/create/route.ts:89` (гейта нет),
  `apps/web/lib/jobs/expire-payments.ts` + `packages/db/src/repositories/orders.ts:351`
  (cron хоронит только `pending_payment`), `packages/types/src/order-state-machine.ts:45`
  (перехода `ready_for_payment → expired` не существует).
- **В чём баг:** курс USDT/RUB фиксируется при `propose_order`, UI пишет «Цена
  зафиксирована до <expiresAt>» — но сервер это не проверяет. Заказ-черновик в
  `ready_for_payment` живёт вечно (cron его не видит), остаётся в `PAYABLE_STATUSES`
  кабинета, и `payments/create` охотно выставит счёт через недели по устаревшему курсу
  (включая fallback 77₽ при недоступном Rapira).
- **Как проявляется:** клиент оформляет заказ, ждёт роста курса, платит по старой цене —
  односторонний опцион против маржи. Ни алёрта, ни recovery.
- **Фикс (3 слоя):**
  1. `@oplati/types`: добавить `'expired'` в `allowedTransitions.ready_for_payment`.
  2. `@oplati/db`: `findExpiredPendingOrders` → `findExpiredPayableOrders` — статусы
     `IN ('ready_for_payment','pending_payment')`, guard `NOT EXISTS succeeded` сохранить.
     Cron `expire-payments` использует новую функцию (текст уведомления тот же).
  3. `payments/create`: до вызова L&P — если `status='ready_for_payment'` и
     `expiresAt < now()` → `transitionOrder(expired)` + `409 { error: 'order_expired' }`
     (закрывает 15-минутное окно между прогонами cron). Хелпер `isPriceLockExpired`
     в `apps/web/lib/payments/expiry.ts` (route.ts не может экспортировать лишнее).
- **Тесты:** state machine (types), PGlite — черновик с истёкшим `expires_at` попадает в
  выборку / свежий и оплаченный не попадают (db), unit `isPriceLockExpired` (web).
- **Статус:** сделано в этом сеансе.

### [x] H-3 (ось F) — SPOF: единственный squid-прокси = весь приём денег

- **Где:** `apps/web/lib/loveandpay/proxy-fetch.ts` (squid на Hostinger VPS
  `177.7.34.106:24128`).
- **В чём риск:** L&P принимает запросы только с задекларированного IP. VPS упал →
  `createInvoice` падает у всех клиентов (прямое соединение получит
  `SOURCE_IP_NOT_ALLOWED`). Мониторинга нет — узнаем от клиентов.
- **Фикс, код (сделано):** healthcheck прокси в cron `poll-payment` (каждые 5 мин):
  `apps/web/lib/jobs/proxy-health.ts` — CONNECT через прокси к origin
  `LOVEANDPAY_BASE_URL` с таймаутом; любой HTTP-ответ = прокси жив; сетевая
  ошибка/таймаут = алёрт (pino + Sentry `alert: lnp_proxy.down` + `notifyOps` с
  best-effort дедупом 60 мин на warm-инстансе).
- **Фикс, код (сделано, спутник H-3):** пользовательский сценарий «тех. сбой» —
  `lib/loveandpay/availability.ts` (`isPaymentProviderUnavailable`: TypeError
  fetch-failed / AbortError / 5xx / 429 после ретраев) → `payments/create` отвечает
  `503 provider_unavailable` + запускает healthcheck через `after()` (DM владельцу
  сразу, не через 5 мин); typed `PaymentProviderUnavailableError` в confirm-order →
  веб-кнопка (`/api/orders/confirm`), кабинет (`payOrder`) и AI-чат показывают
  «Оплата временно недоступна — технический сбой. Заказ сохранён, попробуй позже»
  вместо generic-ошибки.
- **Фикс, операционный (решение владельца, НЕ код):**
  - [ ] резервный фиксированный IP: второй дешёвый VPS со squid + задекларировать оба IP
    в кабинете L&P; `LOVEANDPAY_PROXY_URL` — переключение env'ом (redeploy);
  - [ ] внешний uptime-мониторинг VPS (UptimeRobot/Betterstack пинг 177.7.34.106:24128);
  - [ ] runbook в `docs/incidents.md`: что делать при падении прокси (переключить env →
    redeploy; заказы в `ready_for_payment`/`pending_payment` доедут сами — invoice TTL 24ч).
- **Статус:** код сделан в этом сеансе; операционные пункты — за владельцем.

---

## MEDIUM (приоритет 2)

### [x] M-1 (ось A) — цикл в реферальном дереве — СДЕЛАНО

`wouldCreateCycle` в `setReferrerOnce` (referrals.ts): обход `referred_by` вверх от
кандидата-реферера, кап 16 уровней с fail-closed (тот же алгоритм, что в merge-пути
`consumeLinkToken`, где чек уже был). Новый reason `'cycle'`. PGlite-тесты: прямой
цикл A↔B, транзитивный A→B→C, позитивный контроль. TOCTOU-гонка конкурентных взаимных
установок — принятый риск (прецедент merge-пути), задокументировано в коде.

### [x] M-2 (ось A) — payments/create: INSERT платежа и переход вне транзакции — СДЕЛАНО

`upsert + transitionOrder + setOrderExpiresAt` обёрнуты в `db.transaction` (L&P-вызов
остался ДО транзакции); гонка 23505 ловится снаружи — транзакция откатывается целиком,
проигравший получает инвойс победителя. `upsertPaymentByProviderRef`/`setOrderExpiresAt`
переведены на `DBLike`. Тесты: route-тест `route.test.ts` (все три операции получают
ОДИН tx-хендл; заодно часть T-1) + PGlite-регресс отката INSERT платежа.

### [x] M-3 (оси B+E) — `amount_mismatch` без terminal-пути — СДЕЛАНО

Недоплата терминальна: `claimPaymentTerminal` (pending→failed) + заказ → `failed`
(event `payment_amount_mismatch` с expected/got) в одной транзакции (паттерн
processInvoiceTerminal) + `notifyOps` DM владельцу РОВНО один раз (повторы
webhook/poll получают claim=null и DM не шлют). Платёж выпадает из poll-окна —
25-часовой ре-алерт исчез. Тесты: unit handlers (новое поведение + дедуп на повторе).

### [x] M-4 (ось B) — рассинхрон TTL заказа и инвойса L&P — СДЕЛАНО

При выставлении счёта `orders.expires_at` выравнивается по `invoice.expiresAt`
(`setOrderExpiresAt`, PGlite-тест) — cron не обгонит инвойс. Заодно решение
владельца 2026-07-18 по срокам: **фиксация цены (черновик) 24ч → 2ч**
(`TTL_HOURS` в propose-order.ts), **счёт 24ч → 1ч** (`INVOICE_TTL_HOURS` в
payments/create). Сделано в сеансе аудита.

### [x] M-5 (ось E) — «1,000» парсится как $1 — СДЕЛАНО (PR #88)

`normalizeSeparators` в `amount.ts`: запятые с ровно 3 цифрами после (и точкой только
в конце) — разделители тысяч, убираются; одна запятая с 1–2 цифрами — десятичная;
нулевая дробь (`1,00`) и европейский `1.000,50` — двусмысленны → invalid (переспросить).
Тест-таблица в `amount.test.ts` (20 кейсов, включая `1,000`→1000 и `2,500`→$2500).

### [x] M-6 (ось E) — `maxDuration=30` у `/api/chat` меньше бюджета tool-loop — СДЕЛАНО (PR #88)

`maxDuration=90` у `/api/chat` И у `/api/bot` (спутник: link-handoff и tool-loop бота
зовут тот же self-call), таймаут self-call в `confirm-order.ts` 60с → 45с. Конфиг —
проверить смоуком на Preview.

### [x] M-7 (ось E) — битая `pricing_policy` открывает клиентскую цену — СДЕЛАНО (PR #88)

Битая политика → `service_unavailable` (новый код ошибки, HTTP 503 в propose-route) +
Sentry-алерт (это баг данных каталога). Custom-amount — только если политика распарсилась
и ЯВНО состоит из dummy-тарифов. Unit: битый jsonb и `null` → отказ, `proposeOrder`
не вызывается.

### [x] M-8 (ось D) — tool-loop агента: `(handler as any)(input)` — СДЕЛАНО (PR #88)

`TOOL_INPUT_SCHEMAS satisfies { [K in keyof ToolHandlers]: ZodType<вход обработчика> }`
(компилятор форсит и полноту, и совпадение типов) + типизированный `executeToolUse` со
switch (default с `never` — экзостивность). `ToolCallLog.name` честно `string`
(галлюцинированный tool логируется с `is_error`, раньше прятался за кастом).

### [x] M-9 (ось D) — `partner-api.ts` кастит ответы `as` вместо Zod — СДЕЛАНО (PR #88)

Общий модуль `lib/cabinet/referral-api-schemas.ts` (снапшот/выплата/ошибка;
`satisfies z.ZodType<ReferralSnapshot>` привязывает схему к серверному типу),
`partner-api.ts` парсит им ответы. Unit парса — 8 тестов.

### [x] M-10 (ось D) — `handle-update.ts` 1772 строки — СДЕЛАНО (PR #88)

Распил по флоу, поведение 1:1: `persist.ts` (БД), `send.ts` (отправка/split),
`start-menu.ts`, `link-flow.ts`, `support-flow.ts`, `catalog-callbacks.ts`,
`agent-dialog.ts`; `handle-update.ts` — тонкий роутер (350 строк). Typecheck + полный
сьют web 370 зелёные. Тест роутера update'ов — остался желательным (см. T-5).

### [x] M-11 (ось F) — PNG-позы маскота 2.4 MB → LCP

> СДЕЛАНО (PR #90): 6 поз PNG 2.16 MB → WebP 310 KB (sharp q90), mascotSrc → .webp, ASSET_VERSION=3, ErrorScene тоже

`apps/web/components/chat/Mascot.tsx` + `public/mascot/*.png` (290–430 KB каждая).
**Фикс:** конвертировать в webp (как hero/services), `next/image` с `sizes`, приоритет
только первой позе. Это закрывает пункт «LCP» аудита 2026-07-11.

### [x] M-12 (ось F) — отсутствующие частичные индексы под cron-выборки

> СДЕЛАНО (PR #90): миграция 0023 — частичные orders_completed_fulfilled_at_idx и orders_paid_at_idx (предикат recovery — по orders.paid_at, не payments); применена к dev, прод — при мерже

`findOrdersForRenewalReminder` (фильтр `status='completed' AND fulfilled_at BETWEEN`) и
recovery реф-начислений (`paid_at`) сканируют по вечно растущим индексам. **Фикс:** миграция
Drizzle: частичный индекс `(fulfilled_at) WHERE status='completed'` на orders + индекс по
`payments.paid_at` (проверить фактический предикат recovery-запроса перед созданием).

### [x] M-13 (ось F) — retention: messages / order_events / payments.raw_payload растут без чистки

> СДЕЛАНО (PR #90): cron retention (04:15) — messages >90д удаляются, payments.raw_payload >180д очищается, order_events не трогаем; батчи 500×20, unit-тесты

Supabase free tier 500 MB. **Фикс (решение владельца):** политика ретеншна — напр.,
`messages` старше 90 дней удалять кроном (диалоги), `raw_payload` старше 180 дней —
`jsonb_strip`/NULL (сверка уже не нужна), `order_events` НЕ трогать (append-only, аудит).
Оформить отдельным cron'ом с батч-лимитом.

### [x] M-14 (ось F) — `RATE_FALLBACK_USDT_RUB=77` устарел (реальный ~81)

> СДЕЛАНО (PR #90): дефолт RATE_FALLBACK_USDT_RUB 77 → 81 (решение владельца)

Дефолт в `lib/env.ts:180`. **Действие владельца:** задать env на проде актуальным значением
и заложить процесс обновления (или поднять дефолт в коде при следующем релизе).

### [x] M-15 (ось F) — один захардкоженный оператор поддержки

> СДЕЛАНО (PR #90): дефолт-ID удалён из кода, env-only + Sentry-алёрт при незаданном; SUPPORT_OPERATOR_CHAT_ID задан в Vercel prod+preview и локально

`lib/telegram/support.ts:23` — дефолт `379336096` в коде + единственная личка.
**Фикс:** минимум — убрать дефолт из кода (env-only, при незаданном — notifyOps-алёрт);
целевое — Telegram forum-topics (уже в плане CLAUDE.md).

---

## LOW (приоритет 3, группировать по файлам при попутных правках)

> Волна 2026-07-19 (PR #90): закрыты L-2…L-20. L-2 ушёл вместе с удалением
> repeatOrder (L-9). Открытыми остаются L-1 (фильтр валюты в оборотах) и
> L-21 (CSP enforce — ждёт решения владельца).

- [ ] L-1 (A) `referral-progression.ts:59`, `referral-cabinet.ts:61` — фильтр
  `original_currency='USD'` в суммах оборота (guard уже есть в accrue-пути).
- [x] L-2 (A) `lib/cabinet/actions.ts:235` — `as OrderParameters` → `safeParse` (образец —
  `reportPaymentIssue` там же). Заодно закрыть L-9 (repeatOrder битый) — см. ниже.
- [x] L-3 (A) `packages/db/src/repositories/cards.ts:186` — удалить `markActive` (опасный
  примитив смены владельца карты; prod-вызовов нет, только mock в тесте).
- [x] L-4 (A+B) `expire-payments` — при экспайре заказа клеймить его pending-платёж
  (`claimPaymentTerminal(reason='expired')`) в том же проходе.
- [x] L-5 (B) `lib/cabinet/actions.ts:85–89` — `payOrder`: `findPendingPaymentByOrderId`
  вместо нефильтрованного `findPaymentsByOrderId[0]`.
- [x] L-6 (B) `lib/loveandpay/client.ts:64,103` — `POST /invoices`: не ретраить на timeout
  (только на 5xx-без-тела/сетевую до отправки), либо смириться и задокументировать сирот.
- [x] L-7 (B) `payments.ts:38` — поправить устаревший doc-комментарий про upsert из webhook.
- [x] L-8 (C) `lib/env.ts:256,274` — `console.error` → `process.stderr.write` с комментарием-
  обоснованием (bootstrap до pino) или задокументировать исключение в CLAUDE.md.
- [x] L-9 (E) `repeatOrder`/`requestOperator` в `/api/cabinet` — мёртвые с 2026-07-03 и
  repeatOrder сломан для тарифных (tierName никогда не пишется). **Решение владельца:**
  удалить actions целиком ИЛИ чинить. Рекомендация — удалить (UI-кнопок нет).
- [x] L-10 (E) `lib/cabinet/read.ts:78` — `cardValidUntil`: брать реальный `exp_date`
  карты (уже есть в PaySpace `getCardInfo`) вместо `createdAt+180д`.
- [x] L-11 (D) 4 импорта `serverEnv` из `@/lib/env` мимо `env.server.ts` → перевести на
  `@/lib/env.server` (accrue.ts, deep-links.ts, handle-update.ts, deployment-url.ts).
- [x] L-12 (D) `components/chat/toolCards.ts` → `tool-cards.ts` (kebab-case).
- [x] L-13 (D) два расходящихся `formatUsd` (partner/format-usd.ts vs comic/format.ts) →
  один модуль.
- [x] L-14 (D) тесты вне `pnpm typecheck` — добавить `tsc --noEmit -p tsconfig.test.json`
  (или включить тесты в основной tsconfig) во всех workspace.
- [x] L-15 (F) мёртвые env-схемы: `YOOKASSA_*`, `CRYPTOBOT_*`, `TELEGRAM_OPERATORS_GROUP_ID`,
  `PAYSPACE_ACCOUNT_ID`; весь неиспользуемый `clientEnv`/`getClientEnv`. НЕ трогать
  `TRIGGER_*`/`PAYSPACE_WEBHOOK_SECRET` (зарезервированы осознанно).
- [x] L-16 (F) мёртвые экспорты: `paymentRowToWebhookData` (loveandpay/handlers.ts:303),
  `getOrderByShortId` (orders.ts:153), алиас `canTransition` (order-state-machine.ts:62).
- [x] L-17 (F) `scripts/smoke-loveandpay*.mts` — после IP-allowlist бьют мимо прокси →
  добавить поддержку `LOVEANDPAY_PROXY_URL` или пометить устаревшими в шапке файла.
- [x] L-18 (F) незакоммиченный мусор: `rates.json` в корне (в .gitignore или удалить),
  переезд `audit-report-*.html` в `docs/` закоммитить, `docs/fix-plan.md` и
  `docs/known-issues-2026-06-25.md` — заархивировать/удалить (решение владельца).
- [x] L-19 (F) keepalive не пингует dev-Supabase → Preview-БД заснёт через ~7 дней тишины.
  Вариант: локальный скрипт/GitHub Action раз в 3 дня `SELECT 1` в dev-БД.
- [x] L-20 (E) `handle-update.ts:1131` — резолв тарифа по индексу против живого кэша
  каталога (за выключенным флагом BOT_AI_ENABLED) — при включении флага заменить индекс
  на стабильный ключ тарифа в callback_data.
- [ ] L-21 (C) CSP `Report-Only` → enforced после периода наблюдения (план F-12, за владельцем).
- [x] L-22 (UX, находка владельца на смоуке 2026-07-18) — СДЕЛАНО:
  «Карта уже есть» выводилась из `cardIssueFeeKopecks === 0`, а fee=0 бывает и при
  отключённой env-надбавке (dev/preview) — UI врал клиенту без карты. Теперь —
  `showCardAlreadyOwnedNote(fee, hasActiveCard)` (`lib/cabinet/card-fee-note.ts`,
  unit-тесты), `hasActiveCard` прокинут из снапшота (`snapshot.cards.some(active)`)
  в оба места текста (чек + «Как рассчитана сумма»).

## Пробелы тестового покрытия (закрывать вместе с фиксами соответствующих зон)

- [x] T-1 `app/api/payments/create/route.ts` — ЗАКРЫТ (PR #90: repeat_confirm, гонка 23505, парс storedInvoiceSchema); ранее частично с M-2
  (`route.test.ts`: транзакционная связка, дубль isNew=false, гейт order_expired).
  Осталось: repeat_confirm, гонка 23505 → `respondWithExistingPendingPayment`,
  парс `storedInvoiceSchema` из rawPayload.
- [x] T-2 `toAgentHistory` — закрыт фиксом H-1.
- [x] T-3 (закрыт PR #90: unit expire-payments — порядок claim→notify, guard, фоллбеки) оркестрация `expire-payments`/`poll-payment` (guard оплаченного, порядок
  claim→notify) — unit с моками (закрывать вместе с L-4/M-4).
- [x] T-4 (закрыт PR #90: extractInvoiceLink + payOrder строго pending) `payOrder` → `extractInvoiceLink` из rawPayload (закрывать вместе с L-5).
- [ ] T-5 `splitForTelegram`/`tokenizeForSplit`, link-handoff — вместе с M-10 (распил файла).
