# Платежи

> **Изменение от 2026-06-08 (источник правды).** Ранее этот документ описывал
> YooKassa + CryptoBot. Фактическая реализация MVP использует **Love & Pay**
> (RUB/СБП/карта) как единственный платёжный провайдер и **app.pay.space** для
> выпуска виртуальных USD-карт (фаза fulfillment, вне этого документа). Документ
> приведён в соответствие с кодом в `apps/web/lib/loveandpay/` и
> `apps/web/app/api/payments/`. ENUM `payment_provider` в БД сохраняет
> `yookassa`/`cryptobot` для обратной совместимости, но в коде они не задействованы;
> Love & Pay пишется как `provider = 'loveandpay'`.

На MVP поддерживается один провайдер — **Love & Pay** (`https://loveandpay.io/api/v2`):
приём RUB через СБП и карты + котировки USDT→RUB. Архитектура адаптеров сохранена:
добавить провайдера = реализовать клиент в `apps/web/lib/<provider>/` и webhook-роут.

## Карта файлов

| Файл | Назначение |
|---|---|
| `apps/web/lib/loveandpay/client.ts` | HTTP-клиент: HMAC-подпись, retry, Zod-парсинг ответов |
| `apps/web/lib/loveandpay/sign.ts` | `signRequest` (исходящие) + `verifyWebhookSignature` (входящие) |
| `apps/web/lib/loveandpay/handlers.ts` | `processInvoicePaid` / `processInvoiceTerminal` (общие для webhook и cron) |
| `apps/web/lib/loveandpay/errors.ts` | `LoveAndPayApiError` / `LoveAndPayContractError` |
| `packages/types/src/loveandpay.ts` | Zod-схемы запросов/ответов/webhook'ов (источник правды контракта) |
| `apps/web/app/api/payments/create/route.ts` | Внутренний endpoint создания счёта (self-call из `confirm_order`) |
| `apps/web/app/api/payments/loveandpay/route.ts` | Webhook L&P (входящие события) |
| `apps/web/lib/jobs/poll-payment.ts` | Cron-подстраховка от потерянных webhook'ов |
| `apps/web/lib/tool-handlers/{propose,confirm}-order.ts` | AI-tools: расчёт суммы + запуск оплаты |

## Деньги и единицы

- В БД суммы хранятся **в копейках** (`integer`): `orders.amount_rub`, `payments.amount_rub`.
  Никогда `numeric`/`float` (CLAUDE.md, инвариант 3).
- Love & Pay принимает сумму **в рублях** (не копейках): `amount = order.amountRub / 100`.
- `orders.original_amount` — цена сервиса в минимальных единицах исходной валюты
  (центы USD); используется на фазе выпуска карты (top-up в USD).
- **Минимум счёта — 500 ₽** (терминал KANYON). Ниже — гард в `/api/payments/create`
  (`LOVEANDPAY_MIN_AMOUNT_RUB`, дефолт 500) вернёт `below_min_amount` (422) ДО
  вызова L&P, иначе провайдер отвечает `INTERNAL_ERROR` с непрозрачным телом.

## Исходящая подпись (HMAC v2)

```
signature = HMAC-SHA256(secretKey, METHOD + PATH + TIMESTAMP_MS + SHA256(body)) → hex
```

Заголовки исходящих запросов (`apps/web/lib/loveandpay/sign.ts`):

- `x-api-key: pk_test_* | pk_live_*`
- `x-timestamp: <unix ms>`
- `x-signature: <hex>`

**Критично:** в HMAC идёт **полный** path с префиксом версии — `/api/v2/invoices`, а не
короткий `/invoices`. Иначе L&P возвращает `INVALID_SIGNATURE`. Query-параметры
(`/rates?base=...`) в подпись **не** включаются — подписывается только path.

## Идемпотентность (критично)

`payments.UNIQUE(provider, provider_ref)` — БД гарантирует, что второй вызов с тем же
`provider_ref` (= L&P `invoice.id`) не создаст дубликат.

1. **Создание счёта** — `upsertPaymentByProviderRef` (`INSERT ... ON CONFLICT
   (provider, provider_ref) DO UPDATE ... RETURNING *` + флаг `isNew`). Только при
   `isNew=true` двигаем order `ready_for_payment → pending_payment`; повторный
   `confirm_order` отдаёт ссылку на уже созданный invoice без второго перехода.
2. **Обработка webhook** — в `processInvoicePaid` перед переходом проверяем
   `payment.status`: если уже `succeeded` → `idempotent_skip`. Дополнительно
   `transitionOrder` форсит `allowedTransitions` (повторный `paid → paid` = noop).

## Создание счёта (исходящий поток)

`POST /api/v2/invoices` (через `LoveAndPayClient.createInvoice`). Тело
(`loveAndPayInvoiceRequestSchema`):

```json
{
  "amount": 999.0,
  "currency": "RUB",
  "description": "Оплата заказа ORD-7KX42",
  "customer": {},
  "expiresInHours": 24,
  "successUrl": "https://<app>/payment-success?order=ORD-7KX42",
  "kycRequired": false,
  "paymentMethod": "sbp"
}
```

Ответ (`loveAndPayInvoiceResponseSchema`): `{ success, invoice: { id, invoiceNumber,
amount, currency, status, expiresAt, paymentLink, qrPayload?, ... } }`.

> В теле запроса **нет** поля `callbackUrl`/`webhookUrl` — webhook у L&P
> **глобальный на аккаунт** (один URL на весь аккаунт). См. раздел «Webhook».

Внутренний endpoint `/api/payments/create` (защита `X-Internal-Token`):

1. Проверяет `X-Internal-Token` (защита от внешнего вызова).
2. Грузит order; status должен быть `ready_for_payment`, иначе `409`.
3. Гард суммы: `< LOVEANDPAY_MIN_AMOUNT_RUB` → `422 below_min_amount`.
4. Создаёт invoice в L&P (внешний вызов **до** транзакции БД — не держим lock).
5. Идемпотентный upsert payment по `(provider, provider_ref)`.
6. Только если `isNew` — атомарный `transitionOrder → pending_payment`.
7. Возвращает `{ ok, paymentUrl, qrPayload, expiresAt, invoiceId, invoiceNumber }`.

Self-call идёт на **собственный** deployment (`VERCEL_URL`), а не на `APP_URL` —
иначе preview бьёт в production, где нет L&P-ключей и `INTERNAL_API_TOKEN`
(см. комментарий в `confirm-order.ts`).

## Webhook (входящие события)

Endpoint: `POST /api/payments/loveandpay`. Инвариант — **всегда `200 OK`**
(CLAUDE.md, инвариант 6): любая ошибка возвращается в теле (`skipped: <reason>`) +
Sentry, никогда не HTTP-кодом, иначе L&P будет ретраить и забьёт очередь.

**Заголовки** (контракт — см. ниже про discovery):

- `X-Webhook-Event` — тип события (диспатч).
- `X-Webhook-Signature` — `HMAC-SHA256(webhookSecret, rawBody)` → hex.

`rawBody` читается `await req.text()` **до** `JSON.parse` — пересериализация
(`parse → stringify`) меняет порядок ключей/пробелы и инвалидирует HMAC. Сравнение
подписи — через `timingSafeEqual` (anti-timing-attack).

**События** (`loveAndPayWebhookEventSchema`, discriminated union по `event`):

| Событие | Действие |
|---|---|
| `invoice.created` | игнор (`200`, `skipped: created_ignored`) |
| `invoice.paid` | `processInvoicePaid` → payment `succeeded`, order `→ paid`, `dispatchIssueCard` |
| `invoice.expired` | `processInvoiceTerminal` → payment `failed`, order `→ expired` |
| `invoice.cancelled` | `processInvoiceTerminal` → payment `failed`, order `→ cancelled` |

Payload (`loveAndPayWebhookData`): `{ id, invoiceNumber, amount, currency, status,
paidAt?, customer*? }`.

### Webhook глобальный на аккаунт (как у Telegram-бота)

У L&P один webhook-URL на весь аккаунт. Значит preview и production **конкурируют**
за него — одновременно работает только один. Процедура перенаправления —
в [`deployment.md`](deployment.md): при тесте на preview указываем URL на
dev-deployment; при выводе на prod — перенаправляем на prod-URL.

### Discovery контракта (важно)

Имена заголовков, алгоритм/кодировка подписи и имена событий выше — **предполагаемые**
(подтверждаются первым живым вызовом, см. комментарий в `packages/types/src/loveandpay.ts`).
Пока контракт не сверен байт-в-байт, при расхождении `verifyWebhookSignature` вернёт
`false` или Zod не распарсит — и роут тихо ответит `200 skipped`.

Чтобы снять реальный контракт: выставить `LOVEANDPAY_WEBHOOK_DEBUG=1` в env →
webhook залогирует реальные заголовки + `rawBody` (событие
`loveandpay.webhook.debug_contract`) **до** любых проверок → провести один реальный
платёж → сверить лог с Zod-схемами/`verifyWebhookSignature` → поправить расхождения →
**снять флаг**.

## State flow оплаты

```
ready_for_payment
      │ confirm_order → /api/payments/create → L&P createInvoice
      ↓
pending_payment ──── invoice.paid (webhook / poll-payment) ──→ paid
  (payments: pending)│
                     ├──── invoice.expired ──→ expired   (payments: failed)
                     └──── invoice.cancelled ─→ cancelled (payments: failed)

paid ──── issue-card (PaySpace настроен) ──→ in_fulfillment ──→ completed
   └────── PaySpace НЕ настроен ──→ остаётся в paid (ручной fulfillment)
```

### Граница с выпуском карты

После `paid` `processInvoicePaid` синхронно вызывает `dispatchIssueCard → issueCard`.
Если PaySpace не сконфигурирован (`isPaySpaceConfigured()` = false), `issueCard`
**не** валит заказ в `failed`, а оставляет в `paid` (событие
`job.issue_card.skipped_no_paypace` + Sentry warning) — оператор доводит выпуск
вручную. Иначе успешная оплата выглядела бы как провал. Сам выпуск карты —
отдельная фаза (см. `background-jobs.md`).

## Reconciliation (poll-payment)

Webhook может не прийти (сеть, баг провайдера, разрегистрированный URL). Cron
`poll-payment` (`apps/web/lib/jobs/poll-payment.ts`, расписание `*/5 * * * *` в
`vercel.json`):

1. `findPendingPaymentsForPoll` — pending-платежи старше 10 мин и не древнее 25 ч.
2. Для каждого `getInvoice(providerRef)` в L&P.
3. `PAID` → `processInvoicePaid({ recoveredViaPolling: true })` + Sentry warning
   («webhook потерян»). Терминальные → `processInvoiceTerminal`.

> **Vercel Cron'ы выполняются только на production.** На preview `poll-payment`
> сам не запускается. Поэтому подстраховку нужно тестировать там, где cron реально
> крутится, и обеспечить наличие `LOVEANDPAY_*` ключей на production.

Авторизация cron-endpoint'ов — `authorizeCron`: `Authorization: Bearer <CRON_SECRET>`
(Vercel Cron шлёт сам) либо `X-Cron-Token: <CRON_SECRET|CRON_TOKEN>` для ручных
вызовов. Без токена на production → `401`; на preview/dev без токена — разрешено.

## Expire

Cron `expire-payments` (расписание `*/15 * * * *`): заказы в `pending_payment`,
у которых истёк TTL invoice'а, переводятся в `expired`, платёж — в `failed`,
пользователь уведомляется.

## Обработка ошибок L&P

`LoveAndPayClient` парсит и вложенный (`{ success:false, error:{ code, message } }`),
и плоский (`{ error, message?, hint?, code? }`) формат ошибок в `LoveAndPayApiError`
с читаемыми `code`/`message`. Retry — для `429`/`5xx` (max 3, backoff 500ms→1s→2s);
`400`/`401`/`403` — без retry. Контракт-дрифт ответа (Zod fail) →
`LoveAndPayContractError`. Все `fetch` — с `AbortController` (timeout 30s).

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `LOVEANDPAY_API_KEY` | `x-api-key` (pk_test_*/pk_live_*) |
| `LOVEANDPAY_SECRET_KEY` | ключ HMAC исходящих |
| `LOVEANDPAY_WEBHOOK_SECRET` | ключ HMAC входящих webhook'ов |
| `LOVEANDPAY_BASE_URL` | дефолт `https://loveandpay.io/api/v2` |
| `LOVEANDPAY_MIN_AMOUNT_RUB` | минимум счёта (дефолт 500) |
| `LOVEANDPAY_WEBHOOK_DEBUG` | `1` → discovery-лог контракта webhook'а |
| `INTERNAL_API_TOKEN` | защита self-call `confirm_order → /api/payments/create` |
| `CRON_SECRET` | авторизация cron-endpoint'ов |
| `COMMISSION_PERCENT` / `RATE_FALLBACK_USDT_RUB` | расчёт суммы в `propose_order` |

## Тестирование

- **Unit:** `apps/web/lib/loveandpay/*.test.ts` (sign, client, handlers) — Vitest.
- **E2E на dev:** заказ через `@dev_test_podpiska_bot` на сумму ≥ 500 ₽ → оплата →
  проверка `payments.status=succeeded`, `orders.status=paid`, строки
  `payment_succeeded` в `order_events`.
- Webhook L&P **глобальный**: перед E2E зарегистрировать URL на актуальный
  preview branch-alias (формула в `deployment.md`), после — снять/перенаправить.

## Что ЗАПРЕЩЕНО

- Хранить полные номера карт / CVV.
- Принимать оплату без `orders(status='ready_for_payment')`.
- Возвращать пользователю `paymentUrl` без записи в `payments` (потеря трассируемости).
- Делать внешний запрос к провайдеру внутри транзакции БД — только до commit'а.
- Возвращать с webhook-endpoint не-`200` (CLAUDE.md, инвариант 6).
- Пересериализовывать `rawBody` до проверки HMAC.
