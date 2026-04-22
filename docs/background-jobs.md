# Фоновые задачи (Trigger.dev)

Все async и cron-задачи живут в Trigger.dev. SDK `@trigger.dev/sdk`.

## Почему Trigger.dev, не Vercel Queues / pg_cron

- **Trigger.dev v3** — TS-native, durable execution (resumes after crash), рет-рай из коробки, UI для мониторинга
- **Vercel Queues** — публичный beta, меньше фич пока
- **pg_cron** — слишком low-level для event-driven задач

## Каталог задач

### 1. `poll-payment`

**Type:** scheduled task  
**Schedule:** каждые 30 секунд (`*/30 * * * * *`)  
**Назначение:** страховка от потерянных webhook'ов платежей.

**Логика:**
```
1. SELECT p.* FROM payments p
   WHERE p.status = 'pending'
     AND p.created_at < now() - interval '2 minutes'
     AND p.created_at > now() - interval '2 hours';  -- старше 2ч считаем expired
2. Для каждого:
   - provider.fetchStatus(p.provider_ref)
   - если статус изменился → тот же flow, что webhook (через UPSERT по (provider, provider_ref))
```

**Идемпотентность:** через БД-констрейнт `UNIQUE(provider, provider_ref)`. Retry безопасен.

### 2. `expire-payments`

**Type:** scheduled task  
**Schedule:** каждые 10 минут (`*/10 * * * *`)

**Логика:**
```
1. SELECT o.id FROM orders o
   WHERE o.status = 'pending_payment'
     AND o.created_at < now() - interval '60 minutes';
2. Для каждого: transitionOrder(id, 'expired', { type: 'system' })
3. Уведомить пользователя через send-notification
```

### 3. `alert-slow-fulfillment`

**Type:** scheduled task  
**Schedule:** каждые 15 минут

**Логика:**
```
1. SELECT o.id FROM orders o
   WHERE o.status = 'in_fulfillment'
     AND (last_event_time(o.id) < now() - interval '2 hours')
     AND NOT exists (alert already sent in last 1h);
2. Послать личное сообщение supervisor'у в TG + Sentry warning
```

### 4. `handoff-request`

**Type:** event-triggered  
**Trigger:** event `handoff.requested` с payload `{ conversationId, reason, context }`

**Логика:**
```
1. Получить conversation + user + связанный order (если есть)
2. Создать forum topic в TELEGRAM_OPERATORS_GROUP_ID:
   - name: "#<shortId или convId[:6]> <display_name>"
3. Сохранить conversations.telegram_topic_id
4. Запостить в topic:
   - Карточка order (если есть)
   - Последние 10 сообщений из messages
   - Причину handoff и AI-summary
5. Уведомить пользователя: "Оператор подключится в течение ~5 минут"
```

**Retry:** 3 попытки с backoff, при финальном фейле — алерт supervisor'у.

### 5. `send-notification`

**Type:** event-triggered  
**Trigger:** event `notification.send` с payload `{ userId, channel, template, params }`

Отправляет пользователю уведомление по его активному каналу (TG или веб — push при подключённом chat).

**Шаблоны:**
| key | Когда отправляется |
|---|---|
| `payment_succeeded` | order.paid |
| `payment_expired` | order.expired |
| `fulfillment_started` | order.in_fulfillment |
| `fulfillment_completed` | order.completed (с attachment) |
| `fulfillment_failed` | order.failed |

### 6. `reconcile-staff-telegram`

**Type:** scheduled task  
**Schedule:** раз в сутки

Обновляет `staff.telegram_id` если кто-то заходил в группу операторов (чтобы привязать идентичность). Детали — по мере необходимости.

## Event system

Переходы в `state-machine.md` публикуют события:

```
order.status_changed → { orderId, from, to, actorType, actorId }
order.paid           → { orderId, amountRub }
order.completed      → { orderId, attachmentId }
handoff.requested    → { conversationId, reason }
```

Публикация — **только после commit'а транзакции** (post-commit hook или после вернувшегося из `transitionOrder()` результата в том же request).

Подписки — в `apps/web/trigger/*.ts`.

## Идемпотентность задач

Все задачи — идемпотентны:
- Schedule-задачи — детектируют состояние и применяют изменение только если нужно
- Event-задачи — idempotency key на уровне task (Trigger.dev поддерживает)

## Retry policy

| Task | Max retries | Backoff |
|---|---|---|
| poll-payment | 3 | exponential |
| expire-payments | 3 | exponential |
| handoff-request | 5 | exponential, max 5 min |
| send-notification | 5 | exponential |

## Локальная разработка

```bash
pnpm dlx trigger.dev@latest dev
```

Поднимает локальный dev-инстанс, webhooks идут на tunnel. Мок-события можно публиковать через dashboard.

## Production

- Один project на Trigger.dev для всех окружений, разделение по environment (Dev/Staging/Prod)
- Задачи деплоятся командой `pnpm dlx trigger.dev deploy`
- Vercel Build hook вызывает trigger.dev deploy после успешного Next.js билда (через вынесенную команду в CI)

## Что НЕ делать через Trigger.dev

- Real-time ответы пользователю (это inline в webhook/chat endpoint)
- Тяжёлые ML-вычисления (не для этого)
- Очень частые задачи (< 30 сек schedule) — использовать Supabase pg_cron или inline-таймеры
