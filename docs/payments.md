# Платежи

На MVP поддерживаются **YooKassa** (RUB/СБП/карты) и **CryptoBot** (USDT и др.). Архитектура расширяемая — добавить провайдера = имплементировать адаптер.

## Общий контракт провайдера

```typescript
interface PaymentProvider {
  slug: 'yookassa' | 'cryptobot' | 'sbp';
  createPayment(args: {
    orderId: string;
    amountRub: number;              // копейки
    description: string;
    returnUrl: string;
    metadata: { orderId: string; shortId: string };
  }): Promise<{ providerRef: string; paymentUrl: string; expiresAt: Date }>;

  verifyWebhook(req: Request): Promise<{ ok: boolean; event?: PaymentEvent }>;

  // Для poll-payment job
  fetchStatus(providerRef: string): Promise<'pending' | 'succeeded' | 'failed'>;
}
```

Адаптеры живут в `apps/web/lib/payments/{yookassa,cryptobot}.ts`.

## Идемпотентность (критично)

`payments.UNIQUE(provider, provider_ref)` — БД гарантирует, что второй webhook с тем же `provider_ref` **не создаст дубликат**.

Схема обработки webhook'а:
1. Распарсить и проверить подпись
2. `INSERT ... ON CONFLICT (provider, provider_ref) DO UPDATE SET raw_payload = EXCLUDED.raw_payload RETURNING *`
3. Проверить — если текущий `status` уже `succeeded`/`failed` и новый событие такое же — вернуть `200 OK`, не трогать order
4. Если статус реально меняется (напр. pending → succeeded) — вызвать `transitionOrder(orderId, 'paid', ...)`

## YooKassa

Документация: https://yookassa.ru/developers

### Создание платежа

`POST https://api.yookassa.ru/v3/payments`

Headers:
- `Authorization: Basic base64(SHOP_ID:SECRET_KEY)`
- `Idempotence-Key: <uuid v4>` — обязательно! Генерить нов. UUID на каждый запрос, сохранять в `payments.raw_payload.idempotence_key`

Body:
```json
{
  "amount": { "value": "2499.00", "currency": "RUB" },
  "capture": true,
  "confirmation": { "type": "redirect", "return_url": "https://oplati.example.com/chat?order=ORD-7KX42" },
  "description": "Оплата заказа ORD-7KX42",
  "metadata": { "orderId": "uuid", "shortId": "ORD-7KX42" },
  "payment_method_data": { "type": "bank_card" }
}
```

Для СБП — `payment_method_data.type = "sbp"`.

Response: `{ id, status: "pending", confirmation: { confirmation_url } }`.

### Webhook

YooKassa отправляет на `POST /api/payments/yookassa`. События: `payment.succeeded`, `payment.canceled`, `refund.succeeded`.

**Проверка подлинности:**
- IP источника: диапазоны YooKassa (https://yookassa.ru/developers/using-api/webhooks#ip)
- HMAC: если подпись настроена в кабинете (опционально)

**Event shape:**
```json
{
  "event": "payment.succeeded",
  "object": {
    "id": "2c8a2dd7-000f-5000-9000-145f2c34e7b8",
    "status": "succeeded",
    "amount": { "value": "2499.00", "currency": "RUB" },
    "metadata": { "orderId": "..." }
  }
}
```

### Валюты и округление

- YooKassa принимает сумму **в рублях с копейками** (`"2499.00"`)
- Конверсия: `amountRub (integer копейки) / 100` → `"X.XX"`
- Округление: не нужно, копейки всегда точные

### Refund

`POST https://api.yookassa.ru/v3/refunds` с `payment_id` и `amount`. Идемпотентность — `Idempotence-Key`.

## CryptoBot

Документация: https://help.crypt.bot/crypto-pay-api

### Создание invoice

`POST https://pay.crypt.bot/api/createInvoice`

Headers: `Crypto-Pay-API-Token: <CRYPTOBOT_TOKEN>`

Body:
```json
{
  "currency_type": "fiat",
  "fiat": "RUB",
  "amount": "2499",
  "accepted_assets": "USDT,TON",
  "description": "Оплата заказа ORD-7KX42",
  "hidden_message": "Спасибо!",
  "payload": "order:uuid",
  "expires_in": 3600
}
```

Response: `{ invoice_id, pay_url, status: "active" }`.

### Webhook

Endpoint `POST /api/payments/cryptobot`.

**Подпись:** заголовок `crypto-pay-api-signature` = HMAC-SHA256 от body с ключом = SHA256(`CRYPTOBOT_TOKEN`). Проверять обязательно.

**Event shape:**
```json
{
  "update_id": 1,
  "update_type": "invoice_paid",
  "payload": {
    "invoice_id": 123,
    "status": "paid",
    "amount": "2499",
    "asset": "USDT",
    "payload": "order:uuid"
  }
}
```

`payload` кодируем как `order:{{orderId}}` при создании, парсим на webhook.

## State flow оплаты

```
ready_for_payment
      │
      │ confirm_order → createPayment()
      ↓
pending_payment  ─────┬──── webhook succeeded ──→ paid
  (payments:pending)  │
                      ├──── timeout 60min (cron) ──→ expired
                      │
                      └──── user cancel ──→ cancelled
```

## Reconciliation (poll-payment job)

Webhook может не прийти (сеть, баг провайдера). Cron задача `poll-payment` каждые 30 сек:

1. Найти все `payments(status='pending')` старше 2 минут
2. Для каждого вызвать `provider.fetchStatus(providerRef)`
3. Если статус отличается — применить тот же flow, что и webhook (через `INSERT ... ON CONFLICT`, идемпотентно)

## Expire

Cron `expire-payments` раз в 10 мин:
1. `SELECT orders WHERE status='pending_payment' AND created_at < now() - interval '60 minutes'`
2. Для каждого — `transitionOrder(id, 'expired', {type: 'system'})`
3. Уведомить пользователя

## Тестирование

### YooKassa

Тестовый магазин: https://yookassa.ru/my/shop-settings → Тестовый магазин.
Тестовые карты: `5555 5555 5555 4477` (успех), `5555 5555 5555 4444` (отказ).
Webhook URL задаётся в кабинете.

### CryptoBot

Testnet: @CryptoTestnetBot, https://testnet-pay.crypt.bot/api/.
Отдельные `CRYPTOBOT_TEST_TOKEN`.

### Локальная разработка

- Tunnel через ngrok / Cloudflare Tunnel, передать HTTPS URL в настройки webhook у провайдера
- `APP_URL` в `.env.local` = tunnel URL

## Что ЗАПРЕЩЕНО

- Хранить полные номера карт, CVV — никогда
- Принимать оплату без предварительного `orders(status='ready_for_payment')`
- Возвращать пользователю `paymentUrl` без записи в `payments` (потеря трассируемости)
- Делать внешний запрос на провайдера внутри транзакции БД — только после commit'а черновика
