# Observability

Три слоя:
1. **Errors** — Sentry
2. **Structured logs** — Vercel Logs + (опц.) Logtail для долгосрочного хранения
3. **Метрики** — Vercel Analytics (Web Vitals) + ручные бизнес-метрики в админке

## Sentry

### Setup

Пакет: `@sentry/nextjs`. Настройка через `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`.

**Project:** один Sentry project на весь монолит, environment = `development | preview | production`.

### Что ловить

- Все uncaught exceptions — автоматически
- HTTP 500 errors — автоматически
- Ручные `Sentry.captureException(err)` — в catch-блоках критичных путей:
  - обработчик webhook'а платежа
  - `runAgent`
  - `transitionOrder`
  - Trigger.dev task error (Trigger.dev имеет свой UI, но критичные задачи дублировать в Sentry)

### PII scrubbing

Обязательно настроить `beforeSend`:
```typescript
// Описание, AI-агент имплементирует
beforeSend(event) {
  // Удалить тексты сообщений
  if (event.contexts?.breadcrumbs) { /* ... */ }
  // Заменить email, phone, card numbers в breadcrumbs
  return event;
}
```

Denylist PII полей в request body: `content`, `message`, `text`, `email`, `phone`, `card`, `password`, `token`.

### Breadcrumbs

Важные события — явный `Sentry.addBreadcrumb`:
- `order.status_changed` (without payload details)
- `payment.webhook_received` (`{ provider, providerRef, status }` — без сумм/PII)
- `ai.tool_call` (`{ toolName, conversationId }` — без input)

### Alerts

| Alert | Условие | Канал |
|---|---|---|
| Critical error spike | >10 unique errors / 5 мин | Telegram supervisor + Email admin |
| Payment webhook failures | >3 fail / 10 мин | Telegram admin |
| AI tool iteration limit | любой случай | Telegram admin |
| DB connection errors | любой | Telegram admin + Email |

## Structured logs

### Формат

JSON-строки в stdout, Vercel агрегирует:

```json
{
  "timestamp": "2026-04-22T18:00:00.123Z",
  "level": "info",
  "event": "order.transition",
  "orderId": "uuid",
  "shortId": "ORD-7KX42",
  "from": "paid",
  "to": "in_fulfillment",
  "actor": { "type": "operator", "id": "uuid" },
  "durationMs": 42
}
```

**Уровни:** `debug | info | warn | error | fatal`.

**Что логировать:**
- Все HTTP requests: `method, path, status, durationMs, userId?, orderId?`
- Все state transitions заказа
- Все webhook events платежей (без PII)
- AI agent calls: `{ conversationId, stepCount, totalTokens, finishReason }`
- Все задачи Trigger.dev (успех/провал)

**Не логировать:**
- Тексты сообщений пользователей
- Полные payloads от платёжных провайдеров (только whitelist полей)
- Ключи, токены, пароли

### Logger

Использовать `pino` или `@logtape/logtape`. Инициализация в `apps/web/lib/logger.ts`.

## Метрики

### Vercel Analytics
- Web Vitals автоматически для `/chat` и админки
- Custom events через `@vercel/analytics`: `conversion`, `handoff_requested`, `order_completed`

### Бизнес-метрики в админке (Sprint 3)

Дашборд `/admin` отображает:
- Заказы сегодня: создано / оплачено / завершено / провалено
- Revenue в RUB за период
- Conversion rate: визит → draft → paid → completed
- Средний time-to-fulfillment (p50, p95)
- Active conversations (AI / Operator)
- AI handle rate: % диалогов закрытых без handoff

Реализация — SQL-запросы к Supabase + кеширование через Next.js `unstable_cache` на 60 сек.

## Runbook — куда смотреть

| Симптом | Сначала | Затем |
|---|---|---|
| Заказы не создаются | Vercel Logs `/api/bot` | Sentry issues |
| Оплата не регистрируется | Sentry `payment.webhook` | Supabase payments table manually |
| AI не отвечает | Sentry `runAgent` | Anthropic Status page |
| Очередь не исполняется | Trigger.dev dashboard | Vercel Logs |
| БД медленная | Supabase → Reports → Query Performance | pg_stat_statements |
| Клиент не получает уведомление | Supabase `order_events` + Trigger.dev task `send-notification` | TG bot logs |

## SLO (внутренние)

Таргеты для Sprint 3:
- `/api/bot` — p95 < 1.5 сек
- `/api/chat` — p95 time-to-first-token < 2 сек
- Payment webhook — p95 < 500 мс (только запись в БД + event)
- Availability (успешный healthcheck) — 99.5%

Нарушение SLO — ручной review + план фиксов.

## Dashboards (to build)

- **Vercel Analytics** — из коробки, webvitals
- **Supabase Reports** — query performance, DB size
- **Trigger.dev** — task success rate, execution time
- **Sentry Issues** — ошибки по environment
- **Админка `/admin/metrics`** (Sprint 3) — бизнес-метрики

## Что делать при инциденте

1. **Assess** — видимо ли клиентам? Если да — статус-сообщение в TG-боте (временный `/start` текст)
2. **Contain** — выключить проблемный путь через feature flag (если есть) или hotfix деплой
3. **Investigate** — Sentry + Logs + БД state
4. **Fix** — PR с fix, тест
5. **Postmortem** — в `docs/incidents/YYYY-MM-DD-title.md` в течение 48 часов

## Feature flags (будущее)

Для быстрого отключения фич в проде — простая таблица `feature_flags` в БД + кеш в памяти процесса 30 сек. На MVP не критично, но архитектурная возможность оставить.
