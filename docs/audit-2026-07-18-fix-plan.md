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

### [ ] M-1 (ось A) — цикл в реферальном дереве

`packages/db/src/repositories/referrals.ts:123` — `setReferrerOnce` проверяет только
self-referral и `referred_by IS NULL`. Цикл A↔B возможен: реферер без покупок открывает
ссылку своего же реферала → оба вечно фармят комиссию с покупок друг друга.
**Фикс:** в `setReferrerOnce` (и merge-пути `link-tokens.ts:225`) пройти цепочку
`referred_by` вверх от кандидата-реферера; если встретили самого пользователя — отказ
(`{ok:false, reason:'cycle'}`). Глубина ограничена (уровень 1, но цепочка историческая —
кап ~20 итераций). **Тест:** PGlite — A пригласил B, затем B пытается стать реферером A → отказ.

### [ ] M-2 (ось A) — payments/create: INSERT платежа и переход заказа вне транзакции

`route.ts:170–205` — `upsertPaymentByProviderRef` и `transitionOrder(pending_payment)` —
два отдельных await. Сбой между ними: живой инвойс при заказе в `ready_for_payment`.
**Фикс:** обернуть в `db.transaction` (по образцу `processInvoicePaid` — savepoint-паттерн).
Учесть: L&P-вызов остаётся ДО транзакции (не держать lock на HTTP).
**Тест:** PGlite — инжектированный сбой перехода откатывает INSERT платежа.

### [ ] M-3 (оси B+E, подтверждено двумя осями) — `amount_mismatch` без terminal-пути

`apps/web/lib/loveandpay/handlers.ts:79–100` — недоплаченный инвойс не клеймится: платёж
вечно `pending`, poll ре-алёртит 25 ч, заказ позже хоронится как `expired` при частично
полученных деньгах. **Фикс:** завести явный исход — claim платежа в `failed` c
`failure_reason='amount_mismatch'` + `notifyOps` (ручной возврат), заказ → `failed`
(не `expired` — деньги частично пришли). **Тест:** unit handlers + PGlite claim.

### [x] M-4 (ось B) — рассинхрон TTL заказа и инвойса L&P — СДЕЛАНО

При выставлении счёта `orders.expires_at` выравнивается по `invoice.expiresAt`
(`setOrderExpiresAt`, PGlite-тест) — cron не обгонит инвойс. Заодно решение
владельца 2026-07-18 по срокам: **фиксация цены (черновик) 24ч → 2ч**
(`TTL_HOURS` в propose-order.ts), **счёт 24ч → 1ч** (`INVOICE_TTL_HOURS` в
payments/create). Сделано в сеансе аудита.

### [ ] M-5 (ось E) — «1,000» парсится как $1

`apps/web/lib/telegram/amount.ts:46` — `replace(/,/g, '.')` превращает запятую-разделитель
тысяч в десятичную точку. **Фикс:** запятая с ровно 3 цифрами после и без другой точки —
разделитель тысяч (убрать); `1,5` — десятичная. **Тест:** таблица кейсов: `1,000`→1000,
`1,5`→1.5, `1,000.50`→1000.5, `1,00`→invalid.

### [ ] M-6 (ось E) — `maxDuration=30` у `/api/chat` меньше бюджета tool-loop

`app/api/chat/route.ts:56` — self-call `payments/create` имеет таймаут 60с и собственный
`maxDuration=60`; медленный L&P убивает chat-функцию посреди хода (инвойс создан, клиент
получил ошибку, `recordAgentUsage` не выполнен). **Фикс:** `maxDuration=90` у `/api/chat`
+ ужать таймаут self-call в `confirm-order.ts` до 45с. **Тест:** нет (конфиг), проверить smoke.

### [ ] M-7 (ось E) — битая `pricing_policy` открывает клиентскую цену

`apps/web/lib/catalog/propose.ts:109–120` — `safeParse` упал → `tiers=[]` → `every()` на
пустом массиве = true → `isCustomAmount=true` → сервис с фиксированной ценой принимает
`amountUsdCents` клиента. **Фикс:** битая политика тарифного сервиса → отказ
(`service_unavailable`), как делает `build.ts:87` (возвращает null). Custom-amount —
только если политика ЯВНО `custom_amount`. **Тест:** unit — битый jsonb → отказ, не клиентская цена.

### [ ] M-8 (ось D) — tool-loop агента: `(handler as any)(input)` + невынужденная полнота схем

`packages/agent/src/index.ts:282–304` — `TOOL_INPUT_SCHEMAS` покрывает 4 tool'а только
конвенцией; пятый tool без схемы тихо уронит Zod-границу. **Фикс:** типизировать реестр
`satisfies Record<keyof ToolHandlers, ZodSchema>` — компилятор форсит полноту; убрать
`as any` через генерик-диспатч или switch. **Тест:** существующий agent tool-inputs
сьют + компиляция.

### [ ] M-9 (ось D) — `partner-api.ts` кастит ответы `as` вместо Zod

`apps/web/components/partner/partner-api.ts:39,52` — при том что близнец `cabinet-api.ts`
парсит схемами. **Фикс:** Zod-схемы ответов `/api/cabinet/referral` (вынести в общий
модуль, использовать в обоих). **Тест:** unit парса.

### [ ] M-10 (ось D) — `handle-update.ts` 1772 строки

Распилить по флоу: `start-menu.ts`, `support-flow.ts`, `link-flow.ts`, `catalog-callbacks.ts`,
`agent-dialog.ts` + тонкий роутер. Чисто механический рефакторинг, поведение не менять.
Делать ПОСЛЕ закрытия M-3..M-6 (не смешивать с поведенческими фиксами). **Тест:** typecheck
+ существующий сьют; желателен новый тест роутера update'ов.

### [ ] M-11 (ось F) — PNG-позы маскота 2.4 MB → LCP

`apps/web/components/chat/Mascot.tsx` + `public/mascot/*.png` (290–430 KB каждая).
**Фикс:** конвертировать в webp (как hero/services), `next/image` с `sizes`, приоритет
только первой позе. Это закрывает пункт «LCP» аудита 2026-07-11.

### [ ] M-12 (ось F) — отсутствующие частичные индексы под cron-выборки

`findOrdersForRenewalReminder` (фильтр `status='completed' AND fulfilled_at BETWEEN`) и
recovery реф-начислений (`paid_at`) сканируют по вечно растущим индексам. **Фикс:** миграция
Drizzle: частичный индекс `(fulfilled_at) WHERE status='completed'` на orders + индекс по
`payments.paid_at` (проверить фактический предикат recovery-запроса перед созданием).

### [ ] M-13 (ось F) — retention: messages / order_events / payments.raw_payload растут без чистки

Supabase free tier 500 MB. **Фикс (решение владельца):** политика ретеншна — напр.,
`messages` старше 90 дней удалять кроном (диалоги), `raw_payload` старше 180 дней —
`jsonb_strip`/NULL (сверка уже не нужна), `order_events` НЕ трогать (append-only, аудит).
Оформить отдельным cron'ом с батч-лимитом.

### [ ] M-14 (ось F) — `RATE_FALLBACK_USDT_RUB=77` устарел (реальный ~81)

Дефолт в `lib/env.ts:180`. **Действие владельца:** задать env на проде актуальным значением
и заложить процесс обновления (или поднять дефолт в коде при следующем релизе).

### [ ] M-15 (ось F) — один захардкоженный оператор поддержки

`lib/telegram/support.ts:23` — дефолт `379336096` в коде + единственная личка.
**Фикс:** минимум — убрать дефолт из кода (env-only, при незаданном — notifyOps-алёрт);
целевое — Telegram forum-topics (уже в плане CLAUDE.md).

---

## LOW (приоритет 3, группировать по файлам при попутных правках)

- [ ] L-1 (A) `referral-progression.ts:59`, `referral-cabinet.ts:61` — фильтр
  `original_currency='USD'` в суммах оборота (guard уже есть в accrue-пути).
- [ ] L-2 (A) `lib/cabinet/actions.ts:235` — `as OrderParameters` → `safeParse` (образец —
  `reportPaymentIssue` там же). Заодно закрыть L-9 (repeatOrder битый) — см. ниже.
- [ ] L-3 (A) `packages/db/src/repositories/cards.ts:186` — удалить `markActive` (опасный
  примитив смены владельца карты; prod-вызовов нет, только mock в тесте).
- [ ] L-4 (A+B) `expire-payments` — при экспайре заказа клеймить его pending-платёж
  (`claimPaymentTerminal(reason='expired')`) в том же проходе.
- [ ] L-5 (B) `lib/cabinet/actions.ts:85–89` — `payOrder`: `findPendingPaymentByOrderId`
  вместо нефильтрованного `findPaymentsByOrderId[0]`.
- [ ] L-6 (B) `lib/loveandpay/client.ts:64,103` — `POST /invoices`: не ретраить на timeout
  (только на 5xx-без-тела/сетевую до отправки), либо смириться и задокументировать сирот.
- [ ] L-7 (B) `payments.ts:38` — поправить устаревший doc-комментарий про upsert из webhook.
- [ ] L-8 (C) `lib/env.ts:256,274` — `console.error` → `process.stderr.write` с комментарием-
  обоснованием (bootstrap до pino) или задокументировать исключение в CLAUDE.md.
- [ ] L-9 (E) `repeatOrder`/`requestOperator` в `/api/cabinet` — мёртвые с 2026-07-03 и
  repeatOrder сломан для тарифных (tierName никогда не пишется). **Решение владельца:**
  удалить actions целиком ИЛИ чинить. Рекомендация — удалить (UI-кнопок нет).
- [ ] L-10 (E) `lib/cabinet/read.ts:78` — `cardValidUntil`: брать реальный `exp_date`
  карты (уже есть в PaySpace `getCardInfo`) вместо `createdAt+180д`.
- [ ] L-11 (D) 4 импорта `serverEnv` из `@/lib/env` мимо `env.server.ts` → перевести на
  `@/lib/env.server` (accrue.ts, deep-links.ts, handle-update.ts, deployment-url.ts).
- [ ] L-12 (D) `components/chat/toolCards.ts` → `tool-cards.ts` (kebab-case).
- [ ] L-13 (D) два расходящихся `formatUsd` (partner/format-usd.ts vs comic/format.ts) →
  один модуль.
- [ ] L-14 (D) тесты вне `pnpm typecheck` — добавить `tsc --noEmit -p tsconfig.test.json`
  (или включить тесты в основной tsconfig) во всех workspace.
- [ ] L-15 (F) мёртвые env-схемы: `YOOKASSA_*`, `CRYPTOBOT_*`, `TELEGRAM_OPERATORS_GROUP_ID`,
  `PAYSPACE_ACCOUNT_ID`; весь неиспользуемый `clientEnv`/`getClientEnv`. НЕ трогать
  `TRIGGER_*`/`PAYSPACE_WEBHOOK_SECRET` (зарезервированы осознанно).
- [ ] L-16 (F) мёртвые экспорты: `paymentRowToWebhookData` (loveandpay/handlers.ts:303),
  `getOrderByShortId` (orders.ts:153), алиас `canTransition` (order-state-machine.ts:62).
- [ ] L-17 (F) `scripts/smoke-loveandpay*.mts` — после IP-allowlist бьют мимо прокси →
  добавить поддержку `LOVEANDPAY_PROXY_URL` или пометить устаревшими в шапке файла.
- [ ] L-18 (F) незакоммиченный мусор: `rates.json` в корне (в .gitignore или удалить),
  переезд `audit-report-*.html` в `docs/` закоммитить, `docs/fix-plan.md` и
  `docs/known-issues-2026-06-25.md` — заархивировать/удалить (решение владельца).
- [ ] L-19 (F) keepalive не пингует dev-Supabase → Preview-БД заснёт через ~7 дней тишины.
  Вариант: локальный скрипт/GitHub Action раз в 3 дня `SELECT 1` в dev-БД.
- [ ] L-20 (E) `handle-update.ts:1131` — резолв тарифа по индексу против живого кэша
  каталога (за выключенным флагом BOT_AI_ENABLED) — при включении флага заменить индекс
  на стабильный ключ тарифа в callback_data.
- [ ] L-21 (C) CSP `Report-Only` → enforced после периода наблюдения (план F-12, за владельцем).

## Пробелы тестового покрытия (закрывать вместе с фиксами соответствующих зон)

- [ ] T-1 `app/api/payments/create/route.ts` — repeat_confirm, гонка 23505,
  `respondWithExistingPendingPayment`, парс `storedInvoiceSchema` (закрывать вместе с M-2).
- [x] T-2 `toAgentHistory` — закрыт фиксом H-1.
- [ ] T-3 оркестрация `expire-payments`/`poll-payment` (guard оплаченного, порядок
  claim→notify) — unit с моками (закрывать вместе с L-4/M-4).
- [ ] T-4 `payOrder` → `extractInvoiceLink` из rawPayload (закрывать вместе с L-5).
- [ ] T-5 `splitForTelegram`/`tokenizeForSplit`, link-handoff — вместе с M-10 (распил файла).
