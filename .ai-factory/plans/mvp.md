# План: MVP — Love & Pay + app.pay.space (полная автоматизация без оператора)

**Branch:** `mvp`
**Created:** 2026-05-17
**Source:** [`TZ.md`](../../TZ.md)

## Settings

- **Testing:** yes (Vitest; фокус — HMAC-валидация, идемпотентность webhook'ов, расчёт сумм, state-машина)
- **Logging:** verbose (структурированный pino — INFO для бизнес-событий, DEBUG для HTTP/HMAC шагов)
- **Docs:** **не трогаем** `docs/`, `.ai-factory/ROADMAP.md`, `.ai-factory/ARCHITECTURE.md`, `.ai-factory/DESCRIPTION.md` — по решению владельца, MVP это изолированная задача-демо; конфликт TZ ↔ docs (Love & Pay vs YooKassa, отсутствие handoff в MVP) разрешаем позже отдельным ADR. В рамках этой ветки **обновляются только**: `packages/db/src/schema.ts` + миграции, `apps/web/`, `packages/{agent,types}/src/`, plan-файл, тесты.

## Roadmap Linkage

**Milestone:** "none"
**Rationale:** Изолированная демонстрация MVP-флоу; не вписывается в текущий milestone «State machine заказа + AI tools» (там YooKassa + handoff), требует отдельного ADR перед мерджем в дорожную карту.

## Фиксированные решения (по результатам диалога)

- **Курс USD→RUB:** 1 USD = 1 USDT; курс берём `GET /api/v2/rates?base=USDT&quote=RUB`, фиксируем при создании заказа в `orders.usdt_rub_rate_kopecks` + `orders.rate_fixed_at`.
- **Комиссия:** 10% (env `COMMISSION_PERCENT=10`, дефолт в коде = 10).
- **TTL счёта L&P:** 24h (`expiresInHours: 24`).
- **Recycle карт:** 90 дней idle → `recycled` (cron раз в сутки).
- **KYC:** `kycRequired: false` всегда. Если L&P вернёт ошибку — обрабатываем как `failed` без авто-эскалации.
- **Apple Pay:** вне MVP — iCloud/Google помечены `is_active=false` в seed.
- **SMS-верификация:** не вшиваем в бот, отдаём ссылку на инструкцию в success-ответе.
- **Sandbox L&P:** `pk_test_*`/`sk_test_*` на preview, `pk_live_*`/`sk_live_*` на prod.
- **Юрлицо, geo L&P:** плейсхолдеры в FAQ-промпте; уточнить у заказчика, не блокирует код.
- **Handoff оператору:** заглушка — tool `request_human` пишет событие в `order_events` + отвечает «оператор подключится в течение часа». Forum-topics будут в следующей ветке.

## Окружение (Vercel env) — что нужно добавить

| Env | Назначение | Где использовать |
|---|---|---|
| `LOVEANDPAY_API_KEY` | `pk_test_*` / `pk_live_*` | подпись исходящих + заголовок `x-api-key` |
| `LOVEANDPAY_SECRET_KEY` | `sk_test_*` / `sk_live_*` | HMAC подпись запросов |
| `LOVEANDPAY_WEBHOOK_SECRET` | `whsec_*` | проверка `X-Webhook-Signature` |
| `LOVEANDPAY_BASE_URL` | `https://loveandpay.io/api/v2` | базовый URL, отделить для моков в тестах |
| `PAYSPACE_API_KEY` | ключ кабинета app.pay.space | заголовок авторизации |
| `PAYSPACE_ACCOUNT_ID` | id мерчант-аккаунта | в теле запросов выпуска карт |
| `PAYSPACE_BASE_URL` | URL API app.pay.space | моки в тестах |
| `COMMISSION_PERCENT` | `10` | расчёт суммы в `propose_order` |

`.env.local.example` обновляется в задаче 2.

---

## Tasks

> **Принципы для каждой задачи:** Zod на всех границах, никакого `any`/`as` без обоснования, `console.log` запрещён (только `logger.*`), `fetch` всегда с `AbortController` (timeout 10s default, 30s для L&P, 60s для app.pay.space), никаких прямых `UPDATE orders.status` — только через `transitionOrder()`. Все цены — копейки (`integer`); USD — центы. Все импорты — через barrel (`@oplati/db`, `@oplati/types`, `@oplati/agent`).

### Фаза 1 — Schema delta + env (фундамент)

**Task 1.1 — Добавить таблицу `cards` и расширить `payment_provider` enum**

Файлы:
- `packages/db/src/schema.ts` — добавить:
  - В enum `paymentProviderEnum`: значения `loveandpay`, `paypace`.
  - Новый enum `cardStatusEnum`: `active | idle | recycled`.
  - Таблица `cards`:
    - `id uuid PK`, `userId uuid FK users.id ON DELETE RESTRICT`,
    - `provider text NOT NULL DEFAULT 'paypace'`, `providerCardId text NOT NULL UNIQUE`,
    - `panMasked text NOT NULL` (например `**** **** **** 1234`),
    - `status cardStatusEnum NOT NULL DEFAULT 'active'`,
    - `balanceUsdCents integer NOT NULL DEFAULT 0`,
    - `lastUsedAt timestamptz`, `createdAt timestamptz NOT NULL DEFAULT now()`,
    - `recycledAt timestamptz`,
    - индекс `cards_user_id_idx` по `userId`,
    - индекс частичный `cards_idle_idx` по `status` где `status='idle'` (для cron recycle).
  - `.enableRLS()`.
- `packages/db/src/schema.ts` — расширить `orders`:
  - `usdtRubRateKopecks integer` (например `9523456` = 95.23456 RUB/USDT),
  - `rateFixedAt timestamptz`,
  - `expiresAt timestamptz` (TTL счёта),
  - `commissionPercent integer` (хранится как 10 = 10%; снапшот процента на момент заказа),
  - `cardId uuid FK cards.id` (после `issue-card` job).
- `packages/db/src/schema.ts` — расширить `payments`:
  - `providerInvoiceNumber text` (L&P `INV-...`),
  - `recoveredViaPolling boolean NOT NULL DEFAULT false`,
  - `expiresAt timestamptz`,
  - `webhookReceivedAt timestamptz`.

Logging: тут логов нет, но в репозиториях (Task 1.3) — `logger.info('cards.create', { cardId, userId, provider })`.

Acceptance:
- `pnpm --filter @oplati/db typecheck` зелёный.
- `pnpm --filter @oplati/db db:generate` создаёт новый файл миграции (`0004_*.sql`).

---

**Task 1.2 — Применить миграцию и обновить RLS-политики**

Файлы:
- `packages/db/migrations/0004_*.sql` — сгенерирован.
- `packages/db/migrations/0005_rls_cards.sql` — ручной файл с RLS-политикой для `cards`:
  - `service_role` — всё; обычные клиенты — `SELECT` только своих карт через `user_id = current_setting('app.user_id')::uuid` (паттерн уже использован для `orders` в `0001_enable_rls.sql` — повторить).
- Применить через `pnpm --filter @oplati/db db:push` к Supabase (через Supabase MCP — `apply_migration` после ревью).

Logging: --

Acceptance:
- `list_tables` через Supabase MCP показывает `cards` с правильными колонками.
- `select * from cards` от service_role работает; от anon — `permission denied`.

---

**Task 1.3 — Repository-функции для `cards`, `orders`, `payments`**

Файлы:
- `packages/db/src/repositories/cards.ts` — новый:
  - `createCard(input: NewCard): Promise<Card>`,
  - `findActiveByUserId(userId: string): Promise<Card | null>`,
  - `findRecyclableCard(): Promise<Card | null>` — выбирает первую `idle` (для переиспользования; logger.info при попадании),
  - `markIdle(cardId, lastUsedAt)`, `markRecycled(cardId)`, `updateBalance(cardId, deltaCents)`.
- `packages/db/src/repositories/orders.ts` — новый:
  - `createDraftOrder(input): Promise<Order>` — генерация `shortId` (`ORD-` + nanoid base32, 5 chars).
  - `getOrderById(id)`, `getOrderByShortId(shortId)`.
  - **`transitionOrder(orderId, toStatus, payload?)`** — атомарная транзакция: проверка `allowedTransitions` (импорт из `@oplati/types`, см. Task 2.2), `UPDATE orders SET status, *_at = now()` + `INSERT INTO order_events`. Бросает `OrderTransitionError` если переход запрещён. Возвращает обновлённый order. **Это единственный путь смены статуса** — больше нигде `UPDATE orders SET status` быть не должно.
- `packages/db/src/repositories/payments.ts` — новый:
  - `upsertPaymentByProviderRef(input): Promise<{ payment: Payment, isNew: boolean }>` — `INSERT ... ON CONFLICT (provider, provider_ref) DO NOTHING RETURNING *`, если `isNew=false` — `SELECT`-fallback для возврата существующей.
  - `markPaymentSucceeded(paymentId, { webhookReceivedAt, rawPayload })`.
  - `findPendingPaymentsForPoll(): Promise<Payment[]>` — `status='pending' AND created_at < now() - interval '10 min' AND created_at > now() - interval '25 hours'`.
- `packages/db/src/repositories/index.ts` — реэкспорт новых.

Logging: `logger.info('orders.transition', { orderId, from, to })`; `logger.warn('payments.duplicate_webhook', { provider, providerRef })`.

Acceptance:
- `pnpm --filter @oplati/db typecheck` зелёный.
- Юнит-тесты для `transitionOrder` (Task 8.1) пишутся, но не запускаются — БД пока не нужна для типов.

---

**Task 1.4 — Env-переменные и `.env.local.example`**

Файлы:
- `apps/web/lib/env.server.ts` — добавить в Zod-схему: `LOVEANDPAY_API_KEY`, `LOVEANDPAY_SECRET_KEY`, `LOVEANDPAY_WEBHOOK_SECRET`, `LOVEANDPAY_BASE_URL` (default `https://loveandpay.io/api/v2`), `PAYSPACE_API_KEY`, `PAYSPACE_ACCOUNT_ID`, `PAYSPACE_BASE_URL`, `COMMISSION_PERCENT` (z.coerce.number().int().min(0).max(50).default(10)).
- `.env.local.example` — добавить с заглушками и комментариями (где брать ключи, формат `pk_test_*`).

Logging: `logger.info('env.load', { keys })` при старте процесса.

Acceptance:
- `pnpm typecheck` зелёный.
- `pnpm dev` падает с понятной ошибкой Zod если ключи не заданы (за исключением `COMMISSION_PERCENT` — есть дефолт).

---

### 🚦 Commit checkpoint 1

```
feat(db): cards table, extended orders/payments schema, repositories for MVP

- add cards table + cardStatusEnum
- extend orders with rate snapshot / expiresAt / commissionPercent / cardId
- extend payments with providerInvoiceNumber / recoveredViaPolling / webhookReceivedAt
- new repositories: cards, orders (transitionOrder), payments (idempotent upsert)
- env schema: loveandpay + paypace + COMMISSION_PERCENT
```

---

### Фаза 2 — `@oplati/types` Zod-схемы

**Task 2.1 — Zod-схемы Love & Pay**

Файлы:
- `packages/types/src/loveandpay.ts` — новый:
  - `LoveAndPayInvoiceRequestSchema` — body для `POST /invoices` (amount RUB, description, customer*, expiresInHours, successUrl, kycRequired, paymentMethod?).
  - `LoveAndPayInvoiceResponseSchema` — 201-ответ (success, invoice: { id, invoiceNumber, amount, currency, status: 'PENDING'|'PAID'|'EXPIRED'|'CANCELLED', qrCode, qrPayload, paymentLink, originalPaymentUrl?, expiresAt }).
  - `LoveAndPayWebhookEventSchema` — discriminated union по `event` (`invoice.paid` / `invoice.expired` / `invoice.cancelled` / `invoice.created`), data: { id, invoiceNumber, amount, currency, status, paidAt?, customerEmail?, customerName? }.
  - `LoveAndPayRatesResponseSchema` — `{ base, quote, rate, asOf }`.
  - `LoveAndPayErrorCodeSchema` — enum: `INVALID_SIGNATURE | TIMESTAMP_EXPIRED | RATE_LIMIT_EXCEEDED | CYCLE_BLOCKED | VALIDATION_ERROR | PARTNER_INACTIVE | API_BLOCKED | INTERNAL_ERROR`.
  - Маппер `loveAndPayStatusToInternal(status: 'PENDING'|...)` → `'pending'|'succeeded'|'expired'|'cancelled'`.
- `packages/types/src/index.ts` — реэкспорт.

Logging: --

Acceptance: `pnpm --filter @oplati/types typecheck` зелёный; в `apps/web` ссылки на эти схемы импортируются через `@oplati/types`.

---

**Task 2.2 — State machine: `allowedTransitions` table + `OrderTransitionError`**

Файлы:
- `packages/types/src/order-state-machine.ts` — новый:
  - `OrderStatus` (re-export из db enum литералов).
  - `allowedTransitions: Record<OrderStatus, OrderStatus[]>` — для MVP:
    - `draft → clarifying | cancelled`
    - `clarifying → ready_for_payment | cancelled`
    - `ready_for_payment → pending_payment | cancelled`
    - `pending_payment → paid | expired | cancelled | failed`
    - `paid → in_fulfillment | failed | refund_requested`
    - `in_fulfillment → completed | failed`
    - `completed → refund_requested`
    - `refund_requested → refunded | completed`
    - `failed | expired | cancelled | refunded → ` (терминальные)
  - `isAllowedTransition(from, to): boolean`.
  - Класс `OrderTransitionError extends Error` с полями `{ from, to, orderId }`.
- `packages/types/src/index.ts` — реэкспорт.

Logging: --

Acceptance: юнит-тест (Task 8.1) перебирает все пары — разрешённые проходят, запрещённые бросают.

---

**Task 2.3 — Zod-схемы app.pay.space**

Файлы:
- `packages/types/src/paypace.ts` — новый. Заметка: точная схема API app.pay.space не описана в TZ — фиксируем **минимально достаточный контракт** по тексту раздела 6.2, дальше уточняем при реальном подключении:
  - `PaySpaceCreateCardRequestSchema` — `{ accountId, externalUserId, initialBalanceUsdCents }`.
  - `PaySpaceCreateCardResponseSchema` — `{ cardId, pan, panMasked, expMonth, expYear, cvc, balanceUsdCents }`.
  - `PaySpaceTopupRequestSchema` — `{ cardId, amountUsdCents }`.
  - `PaySpaceTopupResponseSchema` — `{ cardId, balanceUsdCents }`.
  - `PaySpaceErrorSchema` — `{ code: string, message: string }`.
- Top-of-file комментарий: «Схема согласована по TZ.md разделу 6.2; уточнить при первом успешном вызове sandbox».
- `packages/types/src/index.ts` — реэкспорт.

Logging: --

Acceptance: `pnpm --filter @oplati/types typecheck` зелёный.

---

### Фаза 3 — Love & Pay HTTP-клиент

**Task 3.1 — HMAC v2 client (исходящие)**

Файлы:
- `apps/web/lib/loveandpay/sign.ts` — новый:
  - `signRequest(method: 'GET'|'POST', path: string, body: string, secretKey: string): { timestamp: string, signature: string }` — HMAC-SHA256(secret, `METHOD + PATH + TIMESTAMP_MS + SHA256(body)`) hex.
  - `verifyWebhookSignature(rawBody: string, headerSignature: string, secret: string): boolean` — отдельная функция (без timestamp), для входящих.
  - **Покрыть юнит-тестами** обе функции (Task 8.1).
- `apps/web/lib/loveandpay/client.ts` — новый:
  - Класс `LoveAndPayClient` с конструктором `(apiKey, secretKey, baseUrl, logger)`.
  - Методы:
    - `createInvoice(input: z.infer<LoveAndPayInvoiceRequest>): Promise<LoveAndPayInvoiceResponse>` — POST `/invoices`.
    - `createCardInvoice(input)` — POST `/invoices` + `paymentMethod: "card"`.
    - `getInvoice(id: string): Promise<LoveAndPayInvoiceResponse['invoice']>` — GET `/invoices/{id}`.
    - `getRates(base: 'USDT', quote: 'RUB'): Promise<LoveAndPayRatesResponse>` — GET `/rates?base=USDT&quote=RUB`.
  - HTTP — `fetch` + `AbortController` timeout 30s.
  - Retry-политика для 429 / 500: exponential backoff, max 3 ретрая. Логирование каждой попытки. На 400/401/403 — не ретраим.
  - Парсинг ответа через Zod-схемы из `@oplati/types`. На несоответствии → `LoveAndPayApiError`.
  - Узкие, типизированные ошибки: `LoveAndPayApiError extends Error` с `{ code, httpStatus, requestId }`.
- `apps/web/lib/loveandpay/index.ts` — barrel + ленивая инициализация singleton (`getLoveAndPayClient()`).

Logging:
- `logger.debug('loveandpay.request', { method, path, timestamp })`,
- `logger.info('loveandpay.response.ok', { method, path, status, invoiceId })`,
- `logger.warn('loveandpay.retry', { attempt, code, httpStatus })`,
- `logger.error('loveandpay.error', { code, httpStatus, message })` + `Sentry.captureException`.

Acceptance:
- Юнит-тест на `signRequest` против заранее посчитанной подписи (Task 8.1) проходит.
- `pnpm typecheck` зелёный.

---

**Task 3.2 — Endpoint `POST /api/payments/create`**

Файлы:
- `apps/web/app/api/payments/create/route.ts` — новый:
  - **Внутренний endpoint** — дёргается только из tool-handler (см. Task 5.2). Защита: проверяем `X-Internal-Token` (env `INTERNAL_API_TOKEN`, добавить в `env.server.ts`). На невалидном → `401`.
  - Body: `{ orderId, paymentMethod: 'sbp' | 'card' }` (Zod).
  - Алгоритм:
    1. Загружаем `order` через `getOrderById`. Если `status !== 'ready_for_payment'` → `409`.
    2. Загружаем `user` (нужен displayName, phone, email для invoice).
    3. Создаём L&P invoice: amount = `order.amountRub / 100` (рубли, не копейки), description = `"<service> — заказ <shortId>"`, expiresInHours=24, successUrl = TG deep-link с `start=paid_<shortId>`, kycRequired=false.
    4. `upsertPaymentByProviderRef({ orderId, provider: 'loveandpay', providerRef: invoice.id, providerInvoiceNumber, amountRub: invoice.amount * 100, status: 'pending', expiresAt: new Date(invoice.expiresAt), rawPayload: invoice })`.
    5. `transitionOrder(orderId, 'pending_payment', { paymentId, invoiceId })`.
    6. Ответ: `{ paymentUrl: invoice.paymentLink, qrPayload: invoice.qrPayload, expiresAt: invoice.expiresAt }`.
  - Все шаги — в одной транзакции (Drizzle `db.transaction(async (tx) => { ... })`); внешний HTTP-вызов **до** транзакции (idempotency: при дубле — `upsert` вернёт существующую запись).

Logging:
- `logger.info('payments.create.start', { orderId, paymentMethod })`,
- `logger.info('payments.create.invoice_created', { orderId, invoiceId, amountRub })`,
- `logger.error('payments.create.failed', { orderId, code })` + Sentry.

Acceptance:
- Curl/Postman вручную → ответ 200 с `paymentUrl`. (Полный smoke — Task 8.3.)

---

**Task 3.3 — Webhook `POST /api/payments/loveandpay`**

Файлы:
- `apps/web/app/api/payments/loveandpay/route.ts` — новый:
  - `export const runtime = 'nodejs'`, `export const dynamic = 'force-dynamic'`.
  - Читаем `rawBody = await request.text()` **до** `JSON.parse` — критично для HMAC (см. TZ 6.5.4).
  - Заголовки: `X-Webhook-Event`, `X-Webhook-Signature`. Если хоть один отсутствует → `200 OK` + `{ error: 'missing headers' }` (HTTP 200 чтобы L&P не ретраил мусор; ошибку логируем в Sentry).
  - `verifyWebhookSignature(rawBody, signatureHeader, env.LOVEANDPAY_WEBHOOK_SECRET)`. Если invalid → `200 OK` + Sentry critical alert.
  - `JSON.parse(rawBody)` → Zod-парсинг через `LoveAndPayWebhookEventSchema`. Невалидно → `200 OK` + Sentry.
  - Обработка по `event`:
    - **`invoice.paid`:**
      1. `db.transaction`:
         - найти `payment` по `(provider='loveandpay', provider_ref=data.id)`. Если нет → `200 OK` + Sentry warning (платёж без нашего заказа; L&P шлёт по нашему `successUrl`, такого быть не должно).
         - если `payment.status === 'succeeded'` → `200 OK` сразу (идемпотентность).
         - `markPaymentSucceeded(payment.id, { webhookReceivedAt, rawPayload: body })`.
         - `transitionOrder(payment.orderId, 'paid', { paymentId: payment.id })`.
      2. Enqueue Trigger.dev job `issue-card` с `{ orderId: payment.orderId }`.
      3. `200 OK`.
    - **`invoice.expired` / `invoice.cancelled`:**
      1. `db.transaction`:
         - найти `payment` → если уже не `pending` → `200 OK`.
         - `markPaymentStatus(payment.id, 'expired' | 'failed')` (новый helper в `repositories/payments.ts`).
         - `transitionOrder(payment.orderId, 'expired' | 'cancelled', { reason: 'webhook_'+event })`.
      2. `200 OK`.
    - **`invoice.created`:** игнорируем, `200 OK`.
  - **Любой `throw` внутри** → `200 OK` + Sentry.captureException. Webhook никогда не возвращает 4xx/5xx.

Logging:
- `logger.info('loveandpay.webhook.received', { event, invoiceId, signatureValid })`,
- `logger.info('loveandpay.webhook.processed', { event, orderId, action })`,
- `logger.warn('loveandpay.webhook.idempotent_skip', { paymentId })`,
- `logger.error('loveandpay.webhook.unexpected_error', { error })` + Sentry.

Acceptance:
- Юнит-тест с моком-телом и заранее подсчитанной подписью (Task 8.2): `invoice.paid` дважды подряд → один переход в `paid`, один `order_events`.
- Юнит-тест: невалидная подпись → `200 OK`, никаких записей в БД.

---

### 🚦 Commit checkpoint 2

```
feat(payments): love & pay v2 integration — HMAC client + create endpoint + idempotent webhook
```

---

### Фаза 4 — app.pay.space клиент

**Task 4.1 — HTTP-клиент app.pay.space**

Файлы:
- `apps/web/lib/pay-space/client.ts` — новый:
  - Класс `PaySpaceClient(apiKey, accountId, baseUrl, logger)`.
  - Методы:
    - `createCard({ externalUserId, initialBalanceUsdCents }): Promise<PaySpaceCreateCardResponse>` — POST.
    - `topupCard({ cardId, amountUsdCents }): Promise<PaySpaceTopupResponse>` — POST.
    - `getCard(cardId)` — GET (для cron recycle).
  - Авторизация: `Authorization: Bearer <PAYSPACE_API_KEY>` (заглушка — точный формат уточнить при подключении; помечено TODO в коде).
  - Timeout 60s (выпуск карты медленный).
  - Retry: max 2 для 5xx; не ретраим 4xx.
  - Zod-парсинг ответов; `PaySpaceApiError` на несоответствии.
- `apps/web/lib/pay-space/index.ts` — barrel + `getPaySpaceClient()`.

Logging:
- `logger.info('paypace.create_card.start', { externalUserId, amountUsdCents })`,
- `logger.info('paypace.create_card.ok', { cardId, panMasked })` — **никогда не логируем full PAN/CVC** (даже на DEBUG),
- `logger.error('paypace.error', { code, httpStatus })` + Sentry.

Acceptance: `pnpm typecheck` зелёный. Юнит-тест на моки `fetch` (Task 8.2).

---

### Фаза 5 — `@oplati/agent` tools и handlers

**Task 5.1 — Определение tool-интерфейса в `@oplati/agent`**

Файлы:
- `packages/agent/src/tools.ts` — обновить (текущее — заглушки):
  - Tool definitions для Anthropic SDK (input_schema через Zod):
    - `search_catalog(query: string) → Array<{ id, slug, name, basePriceUsdCents, requiresKyc }>`.
    - `propose_order(serviceId: string, amountUsdCents: number, paymentMethod?: 'sbp'|'card') → { orderId, shortId, amountRubKopecks, commissionKopecks, totalRubKopecks, rateUsdRubKopecks, expiresAt }` — **не платёж, только расчёт + create draft → ready_for_payment**.
    - `confirm_order(orderId: string) → { paymentUrl, qrPayload, expiresAt }` — дёргает `/api/payments/create`.
    - `request_human(orderId: string | null, reason: string) → { acknowledged: true }` — заглушка: добавить `order_events` запись `event_type='human_requested'` + `payload: { reason }`.
- `packages/agent/src/index.ts` — интерфейс `ToolHandlers` с этими 4 методами (реализация остаётся в `apps/web`).

Logging: tool-уровень — `logger.info('agent.tool.call', { tool, args })`, `logger.info('agent.tool.result', { tool, durationMs })`.

Acceptance: `pnpm --filter @oplati/agent typecheck` зелёный. Юнит-тест: tool schema валидирует валидный input и режектит невалидный (Task 8.1).

---

**Task 5.2 — Реализация `ToolHandlers` в `apps/web/lib/tool-handlers/`**

Файлы:
- `apps/web/lib/tool-handlers/index.ts` — фабрика `createToolHandlers({ userId, conversationId }): ToolHandlers`.
- `apps/web/lib/tool-handlers/search-catalog.ts`:
  - `SELECT id, slug, name, pricing_policy FROM services WHERE is_active = true AND (name ILIKE %q% OR slug ILIKE %q%) LIMIT 10`. Возвращает `basePriceUsdCents` из `pricing_policy.basePriceUsdCents` (Zod-нарезка).
- `apps/web/lib/tool-handlers/propose-order.ts`:
  1. Загружаем `service` (если нет — кидаем `ToolError('service_not_found')`).
  2. `rate = (await loveandpay.getRates('USDT','RUB')).rate` — в RUB за 1 USDT.
  3. `commissionPercent = env.COMMISSION_PERCENT`.
  4. `subtotalRub = round(amountUsdCents/100 * rate * 100)` (копейки).
  5. `commissionKopecks = round(subtotalRub * commissionPercent / 100)`.
  6. `totalRub = subtotalRub + commissionKopecks`.
  7. `createDraftOrder({ userId, serviceId, status:'ready_for_payment', amountRub: totalRub, originalAmount: amountUsdCents, originalCurrency:'USD', usdtRubRateKopecks: round(rate*1e6), rateFixedAt: now, commissionPercent, expiresAt: now+24h })` — `status` сразу `ready_for_payment` (для MVP пропускаем `clarifying`).
  8. Возвращаем калькуляцию.
- `apps/web/lib/tool-handlers/confirm-order.ts`:
  - Fetch `POST /api/payments/create` с `X-Internal-Token`. Прокидываем ответ.
- `apps/web/lib/tool-handlers/request-human.ts`:
  - Вставляем `order_events { event_type:'human_requested', actor_type:'ai', payload:{ reason } }`. Сейчас никуда не нотифицируем — это заглушка под будущий milestone.

Logging: на каждом handler-методе — start/ok/err.

Acceptance: интеграционный тест (с тестовой БД через docker-compose **позже** — пока юнит на моках db, Task 8.1).

---

**Task 5.3 — Подключить tools к Anthropic-агенту**

Файлы:
- `packages/agent/src/index.ts` — обновить `run()`:
  - Принимать `toolHandlers: ToolHandlers`.
  - Цикл tool-use: на каждом `tool_use` блоке из ответа Claude — вызываем соответствующий handler, кладём результат в `tool_result` и шлём обратно. Max 6 итераций (защита от бесконечного цикла).
- `packages/agent/src/prompts.ts` — обновить системный промпт под MVP:
  - Описать сценарий из TZ раздела 6.1.
  - Тон из TZ 5.1 (дружелюбный, без давления, не исчезаем после оплаты).
  - Пример диалога с tool-calls (одношотный prompt-инжиниринг).
  - Юрлицо/реквизиты — плейсхолдер `[РЕКВИЗИТЫ — TODO]`, не выдумывать.

Logging: `logger.info('agent.run', { iterations, toolCalls, durationMs })`.

Acceptance: ручной smoke — отправить `/start` боту → AI рекомендует сервис, дёргает `search_catalog`, считает `propose_order`, на согласие — `confirm_order`. Полный smoke в Task 8.3.

---

### 🚦 Commit checkpoint 3

```
feat(agent): real tool handlers — search_catalog/propose_order/confirm_order/request_human
```

---

### Фаза 6 — app.pay.space выпуск + Trigger.dev jobs

**Task 6.1 — Bootstrap Trigger.dev в проекте**

Файлы:
- `pnpm add @trigger.dev/sdk -F @oplati/web` (если ещё нет).
- `apps/web/lib/trigger/client.ts` — singleton клиент.
- `apps/web/trigger/index.ts` — entrypoint Trigger.dev (по их конвенции).
- Env: `TRIGGER_SECRET_KEY`, `TRIGGER_PROJECT_REF` — добавить в Zod-схему + `.env.local.example`. **На Vercel этого пока может не быть** — если Trigger.dev ещё не подключён в проекте, помечаем как `optional` в Zod и fallback: jobs дёргаются **синхронно** в webhook (тоже работает, но `issue-card` может выйти за timeout fluid compute — это known risk, фиксируем в TODO).

Logging: --

Acceptance: `pnpm typecheck` зелёный. Если Trigger.dev не настроен — `issue-card` всё равно работает (sync fallback).

---

**Task 6.2 — Job `issue-card`**

Файлы:
- `apps/web/trigger/issue-card.ts` — новый job:
  - Input: `{ orderId: string }`.
  - Логика:
    1. Загрузить `order` (status должен быть `paid`).
    2. Проверить — есть ли активная карта у `user` (`cards.findActiveByUserId`). Если есть — переиспользуем (`topupCard`).
    3. Если нет — пробуем `findRecyclableCard()`. Если есть idle-карта — `topupCard` + переписать `userId` на текущего пользователя + `markActive`.
    4. Если нет — `createCard({ externalUserId: user.id, initialBalanceUsdCents: order.originalAmount })`.
    5. Записать карту в `cards` (если новая) или обновить (если переиспользована); `order.cardId = card.id`.
    6. `transitionOrder(orderId, 'in_fulfillment', { cardId })` → сразу `transitionOrder(orderId, 'completed', { cardId })`.
    7. Через `apps/web/lib/telegram/bot.ts` отправить пользователю карточку: маскированный PAN + срок + CVC + краткая инструкция активации по сервису.
  - Retry: max 3 ретрая с интервалом 2/10/30 мин. На полный фейл → `transitionOrder(orderId, 'failed')` + Sentry critical + сообщение пользователю «возникла техническая проблема, мы свяжемся с вами».

Logging: `logger.info('issue_card.start/ok/retry/failed')` с `orderId`.

Acceptance: smoke в Task 8.3.

---

**Task 6.3 — Cron `poll-payment` (подстраховка)**

Файлы:
- `apps/web/trigger/poll-payment.ts` — cron каждые 5 минут.
- Логика:
  1. `findPendingPaymentsForPoll()` — все `pending` старше 10 мин и младше 25 часов.
  2. Для каждого: `loveAndPay.getInvoice(payment.providerRef)`.
  3. Если `status === 'PAID'` → вручную вызвать тот же handler, что webhook (рефакторинг: вытащить `processInvoicePaid(payment, eventBody)` в `apps/web/lib/loveandpay/handlers.ts`, использовать оба раза). Пометить `recoveredViaPolling=true` + Sentry warning «webhook был потерян».
  4. Если `EXPIRED` / `CANCELLED` → соответствующий handler.

Logging: `logger.info('poll_payment.tick', { processed, recovered })`.

Acceptance: юнит-тест (Task 8.2) — мокаем L&P-клиент и БД, проверяем recovery-флаг.

---

**Task 6.4 — Cron `expire-payments`**

Файлы:
- `apps/web/trigger/expire-payments.ts` — каждые 15 минут.
- Логика: `SELECT orders WHERE status='pending_payment' AND expires_at < now()`. Для каждого → `transitionOrder('expired')` (он же поместит запись в `order_events`). Отправить пользователю сообщение «срок оплаты истёк, можно создать новый заказ».

Logging: `logger.info('expire_payments.tick', { expired })`.

Acceptance: юнит-тест.

---

**Task 6.5 — Cron `subscription-renewal-reminder`**

Файлы:
- `apps/web/trigger/subscription-renewal-reminder.ts` — раз в сутки в 10:00 МСК (Trigger.dev cron syntax `0 7 * * *` UTC).
- Логика: найти `orders` где `status='completed'` и `fulfilled_at` между 23 и 26 днями назад (за 4–5 дней до 30-дневного цикла). Для каждого → TG-сообщение «через 5 дней закончится подписка на <service>, нужна оплата на следующий месяц? напишите /start».

Logging: `logger.info('renewal_reminder.tick', { sent })`.

Acceptance: юнит-тест на отбор по датам.

---

**Task 6.6 — Cron `recycle-cards`**

Файлы:
- `apps/web/trigger/recycle-cards.ts` — раз в сутки.
- Логика:
  1. Найти карты `status='active' AND last_used_at < now() - interval '90 days'` → `markIdle(cardId, now)`.
  2. Найти карты `status='idle' AND recycled_at IS NULL AND created_at < now() - interval '180 days'` → `markRecycled` (помечаем как доступные для переиспользования через `findRecyclableCard`).

Logging: `logger.info('recycle_cards.tick', { idled, recycled })`.

Acceptance: юнит-тест.

---

### 🚦 Commit checkpoint 4

```
feat(payments): app.pay.space client + trigger jobs (issue-card, poll, expire, renewal, recycle)
```

---

### Фаза 7 — Seed каталога под TZ

**Task 7.1 — Привести seed `services` под TZ раздел 3**

Файлы:
- `packages/db/migrations/0006_seed_mvp_services.sql` — manual SQL migration:
  - `INSERT INTO services (slug, name, category, pricing_policy, requires_kyc, is_active) VALUES ... ON CONFLICT (slug) DO UPDATE ...` — для всех ИИ-сервисов из TZ 3.1, 3.2, 3.3 (`chatgpt-plus`, `claude-pro`, `gemini-advanced`, `perplexity-pro`, `mistral-pro`, `grok-pro`, `github-copilot`, `cursor-pro`, `claude-code`, `windsurf-pro`, `midjourney`).
  - `pricing_policy` jsonb: `{ "type": "fixed_usd", "basePriceUsdCents": 2000 }` (etc.).
  - `UPDATE services SET is_active = false WHERE slug IN ('icloud', 'google-one', 'unity-asset-store')` — non-AI, требуют Apple Pay, вне MVP. Если их нет в текущем seed — просто не добавляем.
- Применить миграцию через Supabase MCP.

Logging: --

Acceptance: `SELECT name FROM services WHERE is_active=true` возвращает 11 ИИ-сервисов.

---

### Фаза 8 — Тесты + smoke + runbook

**Task 8.1 — Юнит-тесты (Vitest)**

Файлы:
- `apps/web/lib/loveandpay/sign.test.ts` — `signRequest` с известной парой (secret + body) → известная подпись (зафиксировать константы); `verifyWebhookSignature` true/false.
- `apps/web/lib/loveandpay/client.test.ts` — мок `fetch`: успешный invoice; 429 → retry → success; 401 → no-retry; невалидный JSON → throw.
- `apps/web/lib/pay-space/client.test.ts` — то же для paypace.
- `packages/types/src/order-state-machine.test.ts` — все разрешённые/запрещённые переходы.
- `apps/web/lib/tool-handlers/propose-order.test.ts` — мок `loveAndPay.getRates`, мок db: проверка расчёта суммы при 10% и rate=100.
- Конфиг Vitest, если нет: `apps/web/vitest.config.ts` (jsdom env не нужна, node ok).

Logging: --

Acceptance: `pnpm --filter web test` зелёный.

---

**Task 8.2 — Интеграционные тесты webhook'а**

Файлы:
- `apps/web/app/api/payments/loveandpay/route.test.ts` — `next-test-api-route-handler` или прямой вызов handler-функции:
  - `invoice.paid` валидная подпись → 200, payment.status='succeeded', order.status='paid', job enqueued (мокаем Trigger.dev).
  - `invoice.paid` повторно (тот же `id`) → 200, нет повторного перехода.
  - `invoice.paid` невалидная подпись → 200, нет изменений в БД, Sentry called.
  - `invoice.expired` → order.status='expired'.
- Юнит-тест `processInvoicePaid` (helper из Task 6.3 рефакторинга).

Logging: --

Acceptance: `pnpm --filter web test` зелёный.

---

**Task 8.3 — End-to-end smoke на preview**

Документ:
- `docs/runbook-mvp.md` — **отдельный файл, не трогаем `docs/payments.md`** — пошаговый чеклист:
  1. Зарегистрировать webhook L&P (test-кабинет): `POST /api/v2/webhooks` с URL preview.
  2. Сохранить выданный `secretKey` в Vercel env (preview).
  3. Аналогично — sandbox app.pay.space.
  4. `/start` дев-боту → диалог с агентом → `propose_order(claude-pro, 2000)` → `confirm_order`.
  5. Открыть `paymentLink` → оплатить (test-карта L&P / реальные ~50₽).
  6. Webhook → `issue-card` job → ответ от бота с данными карты.
  7. Проверить в Supabase: `orders.status='completed'`, `cards.status='active'`.

Logging: --

Acceptance: пройденный чеклист на preview-деплое; зафиксировать дату + invoice_id в `Journal/`.

---

**Task 8.4 — Документация плана и финальный чек**

Файлы:
- Дополнить план-файл `.ai-factory/plans/mvp.md` секцией `## Outcome` после smoke: что работает / что отложено / открытые вопросы которые остались.

Logging: --

Acceptance: PR готов к ревью; описание PR ссылается на TZ.md разделы, перечисляет миграции и env-ключи.

---

### 🚦 Commit checkpoint 5

```
test(mvp): unit + integration tests + smoke runbook
```

---

## Commit Plan (итого)

| # | Чекпоинт | Задачи |
|---|---|---|
| 1 | `feat(db): cards + extended orders/payments + repos` | 1.1–1.4 |
| 2 | `feat(payments): love & pay v2 — client + create + webhook` | 2.1–2.3, 3.1–3.3 |
| 3 | `feat(agent): tool handlers — search/propose/confirm/request_human` | 5.1–5.3 |
| 4 | `feat(payments): app.pay.space + trigger jobs` | 4.1, 6.1–6.6 |
| 5 | `feat(catalog): seed AI-services under TZ`+ `test: unit + integration + smoke` | 7.1, 8.1–8.4 |

После всех 5 чекпоинтов — открыть PR в `main` с пометкой «MVP demo, requires ADR before production».

## Известные риски

1. **API app.pay.space — контракт не зафиксирован в TZ.** Точная форма запросов уточняется при подключении к sandbox; Task 4.1 содержит TODO-комментарий.
2. **Trigger.dev в проекте может быть не настроен.** Sync-fallback в `issue-card` рискует превысить timeout fluid compute (60–90s). Если выявится на smoke — отдельной задачей подключить Trigger.dev в окружение.
3. **Конфликт с Roadmap (YooKassa).** После успешного smoke — обязательный ADR + обновление `docs/payments.md`, `docs/database.md`, `.ai-factory/ROADMAP.md`. **Не делаем в этой ветке** по решению владельца.
4. **Юрлицо/реквизиты** — плейсхолдер в FAQ; до prod-релиза нужны реальные данные от L&P-кабинета.
5. **Geo-ограничения L&P-карт** — уточнить при подключении; если Россия запрещена для L&P-карт (эмитент), это нас не касается — мы используем L&P только как acquiring, карты выдаём через app.pay.space.

## Outcome (заполняется после Task 8.3)

_TBD_
