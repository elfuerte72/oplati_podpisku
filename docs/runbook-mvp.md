# MVP Runbook — Love & Pay + app.pay.space (smoke на preview)

> **Контекст:** ветка `mvp`, отдельная демонстрационная имплементация. Перед мерджем в `main` требуется ADR (см. план `.ai-factory/plans/mvp.md` → «Известные риски»).
>
> **Не путать с `docs/payments.md`** — там описана YooKassa/CryptoBot интеграция основной дорожной карты.

## 1. Подготовка окружения (preview)

### 1.1. Vercel env (Preview)

Заполните в Vercel Project Settings → Environment Variables (Preview):

| Key | Значение | Sensitive |
|-----|----------|-----------|
| `LOVEANDPAY_API_KEY` | `pk_test_*` из кабинета L&P | ✅ |
| `LOVEANDPAY_SECRET_KEY` | `sk_test_*` | ✅ |
| `LOVEANDPAY_WEBHOOK_SECRET` | будет выдан после регистрации webhook (см. 1.2) | ✅ |
| `LOVEANDPAY_BASE_URL` | `https://loveandpay.io/api/v2` | ❌ |
| `PAYSPACE_API_KEY` | ключ sandbox app.pay.space | ✅ |
| `PAYSPACE_ACCOUNT_ID` | id мерчант-аккаунта | ❌ |
| `PAYSPACE_BASE_URL` | `https://app.pay.space/api/v1` (или sandbox URL) | ❌ |
| `COMMISSION_PERCENT` | `10` | ❌ |
| `INTERNAL_API_TOKEN` | `openssl rand -hex 32` | ✅ |
| `CRON_SECRET` | `openssl rand -hex 32` (опционально для preview) | ✅ |

Push в ветку `mvp` → Vercel автоматически собирает preview.

### 1.2. Регистрация webhook L&P

После выкатки preview узнайте URL: `oplati-podpisku-web-git-mvp-<team>.vercel.app`.

```bash
# Получите webhook_secret в ответе.
curl -X POST https://loveandpay.io/api/v2/webhooks \
  -H "X-Api-Key: pk_test_..." \
  -H "X-Timestamp: $(date +%s%3N)" \
  -H "X-Signature: <hmac>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<preview-domain>/api/payments/loveandpay","events":["invoice.paid","invoice.expired","invoice.cancelled"]}'
```

Полученный `whsec_*` положите в Vercel env как `LOVEANDPAY_WEBHOOK_SECRET` (Preview). **Сделайте redeploy** preview (Sensitive-флаг требует пересборки, иначе значение не подхватится).

### 1.3. Регистрация sandbox app.pay.space

Создайте API key + account_id через личный кабинет app.pay.space. Сохраните в env.

### 1.4. Telegram dev-бот

`@dev_test_podpiska_bot` (см. CLAUDE.md → карта Telegram-секретов). Перепривяжите webhook на preview-URL:

```bash
curl "https://api.telegram.org/bot<DEV_TOKEN>/setWebhook?url=https://<preview-domain>/api/bot&secret_token=<DEV_SECRET>"
```

## 2. Smoke-сценарий

### 2.1. Базовый поток (Claude Pro, ~50₽)

1. Откройте чат с `@dev_test_podpiska_bot` в Telegram.
2. Команда `/start` → бот шлёт GREETING.
3. Сообщение: «Хочу оплатить Claude Pro».
4. AI должен:
   - вызвать `search_catalog` (query: «claude»),
   - вызвать `propose_order` (serviceId: `<claude-pro-id>`, amountUsdCents: `2000`),
   - вернуть пользователю сводку с суммой в RUB.
5. Ответ «да» → AI вызывает `confirm_order` → присылает paymentUrl.
6. Откройте paymentUrl в браузере → оплатите тестовой картой L&P.
7. L&P → webhook `invoice.paid` → handler → `processInvoicePaid` → `transitionOrder paid` → `dispatchIssueCard`.
8. `issueCard` (sync через setImmediate):
   - paypace `createCard` → реквизиты,
   - сохранение в БД, `setOrderCardId`,
   - `transitionOrder paid → in_fulfillment → completed`,
   - бот шлёт пользователю реквизиты карты в Telegram.

### 2.2. Проверка в Supabase

```sql
-- Заказ должен быть completed
SELECT id, short_id, status, amount_rub, original_amount, commission_percent, card_id
FROM orders WHERE short_id = 'ORD-XXXXX';

-- Платёж — succeeded, webhook_received_at заполнен
SELECT id, provider, provider_ref, status, webhook_received_at, recovered_via_polling
FROM payments WHERE order_id = '<order-uuid>';

-- Карта — active, привязана к user
SELECT id, user_id, provider_card_id, pan_masked, status, balance_usd_cents
FROM cards WHERE id = '<card-uuid>';

-- Audit log — все переходы статусов
SELECT event_type, from_status, to_status, actor_type, created_at
FROM order_events WHERE order_id = '<order-uuid>'
ORDER BY created_at;
```

Ожидаемые `order_events`:
1. `order_created`, `null → ready_for_payment`, actor `system`
2. `payment_invoice_created`, `ready_for_payment → pending_payment`, actor `system`
3. `payment_succeeded`, `pending_payment → paid`, actor `payment_provider`
4. `card_assigned`, `paid → in_fulfillment`, actor `system`
5. `fulfillment_completed`, `in_fulfillment → completed`, actor `system`

### 2.3. Идемпотентность webhook'а

Повторите тот же webhook вручную:

```bash
curl -X POST https://<preview-domain>/api/payments/loveandpay \
  -H "X-Webhook-Event: invoice.paid" \
  -H "X-Webhook-Signature: <hmac>" \
  -H "Content-Type: application/json" \
  -d '<raw_body_исходного_webhook>'
```

Должно быть: `200 OK { ok: true, result: "idempotent_skip" }`. Никаких новых `order_events`, статус заказа `completed` (не меняется).

### 2.4. Истечение invoice

1. Создайте заказ через бота, **не оплачивайте**.
2. Через 24h cron `expire-payments` переведёт его в `expired`. Для проверки сейчас — дёрните cron вручную:

```bash
curl https://<preview-domain>/api/cron/expire-payments \
  -H "Authorization: Bearer $CRON_SECRET"
```

Бот должен прислать «Срок оплаты заказа ORD-... истёк».

## 3. Cron-эндпоинты (ручные дёрги)

| Endpoint | Расписание | Что делает |
|----------|------------|-----------|
| `GET /api/cron/poll-payment` | каждые 5 мин | Восстанавливает потерянные webhook'и через L&P getInvoice |
| `GET /api/cron/expire-payments` | каждые 15 мин | `pending_payment` с истёкшим `expires_at → expired` |
| `GET /api/cron/renewal-reminder` | ежедневно 10:00 МСК | Напоминание о продлении за 4-7 дней |
| `GET /api/cron/recycle-cards` | ежедневно 06:30 МСК | `active → idle (90d)`, `idle → recycled (180d)` |

Все требуют либо `Authorization: Bearer $CRON_SECRET`, либо `X-Cron-Token: $CRON_SECRET`. На preview без секрета — разрешены (для smoke).

## 4. Логи + observability

- pino → stdout (Vercel UI → Logs)
- Sentry → дашборд проекта (см. SENTRY_DSN env)
- Key events:
  - `loveandpay.webhook.received` / `loveandpay.handlers.*`
  - `job.issue_card.*`
  - `cron.poll_payment.*` (если `recovered > 0` — Sentry warning «webhook потерян»)
  - `tool.propose_order.ok` / `tool.confirm_order.ok`

## 5. Журнал smoke-теста

После прохождения чеклиста зафиксируйте в `.ai-factory/Journal/<дата>.md`:

- дата + время прохождения
- preview URL
- invoice_id из L&P
- card_id из paypace
- order shortId
- duration: от `/start` до отправки реквизитов

## 6. Known issues

- **Trigger.dev не подключён.** issueCard работает sync через `setImmediate` (план Task 6.1). Подстрахован cron'ом `poll-payment`, но fluid-cold-shutdown между webhook'ом и issue-card теоретически возможен.
- **Контракт app.pay.space — приблизительный.** Точная форма запросов sandbox'а уточняется при первом подключении (см. TODO в `apps/web/lib/pay-space/client.ts`).
- **`docs/payments.md` НЕ обновлён** — это решение владельца. Перед prod-релизом нужен ADR + обновление документации.
