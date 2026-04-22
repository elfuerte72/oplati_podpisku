# API Specification

Все endpoints — внутри Next.js App Router, путь `apps/web/app/api/*/route.ts`.

Формат: JSON (кроме `/api/bot`, принимающего сырой Telegram update). Все входящие тела валидируются через Zod. Все ошибки возвращаются как `{ error: string, code?: string }`.

## Публичные endpoints

### `POST /api/bot` — Telegram webhook

**Headers:**
- `X-Telegram-Bot-Api-Secret-Token` — обязательно, сверяется с `TELEGRAM_WEBHOOK_SECRET`

**Body:** сырой Telegram Update (см. [Telegram Bot API](https://core.telegram.org/bots/api#update))

**Response:** `200 OK` всегда (даже при ошибке — иначе Telegram будет ретраить). Ошибки логируются в Sentry.

**Обработка:**
1. Проверить secret-token → при несовпадении `401`
2. Парсить update через grammY
3. Диспатчить в handler:
   - `/start` → приветствие (константа `GREETING`)
   - Обычное сообщение → `runAgent(...)`
   - Callback button → соответствующий action
4. Отправить ответ пользователю

**Timeout:** Telegram ретраит webhook если не получил ответ за 60 сек. Длинные операции — в Trigger.dev.

### `POST /api/chat` — AI streaming (веб-чат)

**Headers:**
- `Cookie: session=...` — идентификация веб-сессии

**Body:**
```json
{
  "messages": [
    { "role": "user", "content": "Хочу Claude Pro" }
  ]
}
```

**Response:** `text/event-stream` (SSE) с событиями от Vercel AI SDK.

**Обработка:**
1. Найти/создать `users` по `web_session_id`
2. Найти/создать `conversations(channel='web')`
3. Сохранить последнее user-сообщение в `messages`
4. Запустить стриминг через AI SDK, токены транслируются клиенту
5. По завершении — сохранить полный ответ в `messages`

**Rate limit:** 20 сообщений / 5 минут на `web_session_id` через Upstash Ratelimit.

### `POST /api/payments/yookassa` — webhook YooKassa

**Headers:**
- `Content-Type: application/json`

**Body:** YooKassa notification object ([спец](https://yookassa.ru/developers/using-api/webhooks))

**Аутентификация:** проверка IP-диапазона YooKassa + HMAC подпись (если настроена).

**Response:**
- `200 OK` при успехе или дубликате (идемпотентный)
- `400` при невалидном body

**Обработка:**
1. Проверить IP/HMAC
2. Парсить event через Zod
3. Найти `payments` по `(provider='yookassa', provider_ref)`
4. Если уже `succeeded` — вернуть `200` (idempotent)
5. Обновить payment + переход order в `paid` через `transitionOrder()`

### `POST /api/payments/cryptobot` — webhook CryptoBot

Аналогично YooKassa, но с HMAC `crypto-pay-api-signature`.

### `GET /api/health` — healthcheck

**Response:** `{ ok: true, timestamp: "..." }`. Проверяет подключение к Supabase (простой `SELECT 1`).

## Приватные endpoints (только `/admin` с Supabase Auth JWT)

### `GET /api/orders`

**Query:** `?status=paid&operator=me&limit=50&offset=0`

**Auth:** Bearer JWT из Supabase Auth. RLS фильтрует по ролям.

**Response:**
```json
{
  "orders": [
    { "id": "...", "shortId": "ORD-...", "status": "paid", "user": {...}, "amountRub": 249900 }
  ],
  "total": 123
}
```

### `GET /api/orders/:id`

Полная карточка заказа + история событий + сообщения conversation.

### `POST /api/orders/:id/take`

Оператор берёт заказ в работу: `paid → in_fulfillment`, `assigned_operator_id = auth user`.

### `POST /api/orders/:id/complete`

Body:
```json
{ "attachmentId": "uuid-fulfillment-proof" }
```

Переход `in_fulfillment → completed`, отправить уведомление пользователю.

### `POST /api/orders/:id/fail`

Body: `{ "reason": "string" }`. Переход `in_fulfillment → failed`.

### `POST /api/orders/:id/refund`

Только `supervisor`/`admin`. Body: `{ "reason": "..." }`. Переход в `refund_requested`, запуск refund через провайдера.

### `POST /api/attachments`

Upload скриншота/документа. Multipart form-data. Сохраняется в Supabase Storage bucket по `kind`.

Body:
- `file` (binary)
- `kind` (`payment_proof | kyc | fulfillment_proof | other`)
- `orderId` (optional)
- `messageId` (optional)

Response: `{ attachmentId, storagePath, url }`.

### `GET /api/catalog`

Публичный каталог. Без auth.

Response:
```json
{
  "services": [
    { "slug": "claude-pro", "name": "Claude Pro", "tiers": [...] }
  ]
}
```

Используется агентом через `search_catalog` и фронтом на лендинге.

### `POST /api/admin/catalog` / `PUT /api/admin/catalog/:id` / `DELETE`

Только `admin`. CRUD на `services`.

## Trigger.dev ingest

### `POST /api/trigger/[...trigger]`

Обрабатывается `@trigger.dev/nextjs` package. Не кодировать вручную — использовать SDK.

## Общие правила

### Формат ошибок

```json
{ "error": "Human-readable description", "code": "INVALID_INPUT" }
```

HTTP коды:
- `400` — невалидный input
- `401` — не аутентифицирован
- `403` — нет прав
- `404` — не найдено
- `409` — конфликт (напр. неверный переход state machine)
- `422` — валидация упала
- `429` — rate limit
- `500` — внутренняя ошибка (логировать в Sentry)

### Идемпотентность

POST-webhook'и провайдеров — идемпотентные через `UNIQUE(provider, provider_ref)`. Повторный вызов возвращает `200` без side-effects.

### CORS

- `/api/chat`, `/api/catalog`, `/api/health` — `Access-Control-Allow-Origin: <APP_URL>`
- Остальные — без CORS (вызовы только от внешних сервисов с другим auth)

### Логирование

Каждый request логируется: `{ method, path, status, durationMs, userId?, orderId? }`. PII не логируется.
