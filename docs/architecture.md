# Архитектура

## Стек
| Слой | Выбор |
|---|---|
| Язык | TypeScript 5.x (Node.js 24 LTS) |
| Монорепа | Turborepo + pnpm workspaces |
| Фреймворк | Next.js 16 (App Router) |
| Telegram-бот | grammY (webhook) |
| Веб-чат | Vercel AI SDK v6 `useChat` + стриминг |
| AI | Anthropic Claude напрямую через `@anthropic-ai/sdk` |
| БД | Supabase Postgres 17 |
| ORM | Drizzle |
| Auth | Supabase Auth (только для `/admin`) |
| Storage | Supabase Storage |
| Realtime | Supabase Realtime |
| Очереди/cron | Trigger.dev |
| Деплой | Vercel (fra1) |
| Мониторинг | Sentry + Vercel Observability |
| Валидация | Zod (источник правды для контрактов) |
| UI | shadcn/ui + Tailwind |

## Modular Monolith

```
oplati_podpicky/
├── apps/web/              ← Next.js 16, один деплой
│   ├── app/
│   │   ├── page.tsx           лендинг
│   │   ├── chat/page.tsx      веб-чат
│   │   ├── admin/             панель операторов
│   │   └── api/
│   │       ├── bot/route.ts        Telegram webhook
│   │       ├── chat/route.ts       AI streaming
│   │       ├── payments/yookassa/  webhooks
│   │       ├── payments/cryptobot/
│   │       └── trigger/            Trigger.dev endpoints
│   └── lib/
├── packages/
│   ├── agent/             AI-агент + промпты + tools (шарится TG и веб)
│   ├── db/                Drizzle схема + клиент + репозитории
│   ├── types/             Zod-схемы (единый источник правды)
│   └── ui/                shadcn компоненты (опционально во 2м спринте)
└── docs/
```

**Правило границ:** `apps/web` импортирует только публичные экспорты пакетов. `agent` не лезет в БД напрямую — только через `db` репозитории. `types` не зависит ни от чего.

## Поток данных

```
User (TG)  ──┐
             ├──> /api/bot (grammY) ─┐
User (Web) ──┤                       │
             └──> /api/chat ─────────┼──> agent.run(messages, ctx)
                                     │         │
                                     │         ├── tools: search_catalog,
                                     │         │          propose_order,
                                     │         │          confirm_order,
                                     │         │          request_human
                                     │         ↓
                                     │    Anthropic Claude
                                     ↓
                              Supabase (Postgres)
                                     │
                                     ├── Realtime ──> Admin UI
                                     └── Storage ──> скриншоты

Payment webhook ──> /api/payments/* ──> order.paid
                                            │
                                            ↓
                                    Trigger.dev job ──> notify operator
                                                       (TG forum-topic)
```

## Схема БД (логическая)

```
users ──< conversations ──< messages
  │
  ├──< orders ──< order_events (audit log, append-only)
  │     │          
  │     ├── service_id ──> services (каталог)
  │     ├── assigned_operator_id ──> staff
  │     └──< payments
  │           │
  │           └──< attachments (payment proof, KYC, fulfillment proof)

staff ──< order_events
```

### Ключевые инварианты
1. **`order_events` append-only** — никогда не удаляем, не апдейтим. Любое изменение статуса = новая строка.
2. **Идемпотентность** — каждый входящий webhook имеет `(provider, provider_ref)` unique; повторный не создаёт дубль.
3. **`amount_rub` в копейках (`integer`)** — никогда в `numeric`/`float`.
4. **`user.telegram_id` и `user.web_session_id`** — одна запись может иметь оба (после связывания).

## State Machine заказа

```
    [draft]
       │
       ↓ (AI сформулировал)
    [clarifying] ──────────┐
       │                   │ нужен KYC
       ↓                   ↓
    [ready_for_payment]  [kyc_required] → [clarifying] (после KYC)
       │
       ↓ (инвойс)
    [pending_payment] ──────┬── timeout ──> [expired]
       │                    └── cancel ───> [cancelled]
       ↓ paid
    [paid]
       │
       ↓ оператор взял
    [in_fulfillment]
       │         │
    успех │         │ не удалось
       ↓         ↓
    [completed]  [failed] ──> [refund_requested] ──> [refunded]
       │
       └──> [refund_requested] (по запросу пользователя)
```

Все переходы атомарные: транзакция, в которой (а) меняется `orders.status`, (б) вставляется строка в `order_events` с actor + payload.

## Handoff оператору

**Механика:** Telegram-группа операторов с включёнными форумами (Supergroup + Topics).

1. Триггер: AI вернул `request_human` или пользователь нажал кнопку «позвать оператора».
2. Worker создаёт topic `#<order_short_id> @username` в группе, постит снапшот:
   - Карточка заказа (сервис, тариф, сумма, статус)
   - Последние 10 сообщений диалога
3. Сообщения пользователя проксируются в topic; ответы операторов — пользователю. Бот-посредник.
4. `conversations.handoff_mode = 'operator'`, `conversations.assigned_operator_id = X`.
5. Оператор пишет `/ai_back` → `handoff_mode = 'ai'`, topic архивируется.

**Почему так:** не нужна своя operator-UI на MVP; история вся в БД; 24/7 «бесплатно» через Telegram.

## Очереди (Trigger.dev)

| Задача | Периодичность | Что делает |
|---|---|---|
| `poll-payment` | каждые 30 сек | подстраховка от потерянных webhook'ов |
| `expire-payments` | раз в 10 мин | `pending_payment` > 1 часа → `expired` |
| `alert-slow-fulfillment` | раз в 15 мин | `in_fulfillment` > 2 часов → пинг супервизору |
| `handoff-request` | по событию | создать topic в TG-группе с контекстом |
| `fulfillment-complete` | по событию | уведомить пользователя + email-receipt |

## Безопасность

- Проверка `X-Telegram-Bot-Api-Secret-Token` на `/api/bot`
- HMAC-подпись всех платёжных webhook'ов
- RLS в Supabase: по роли `staff`, по `assigned_operator_id`
- Secrets в Vercel env, никогда в коде
- Rate limiting (Upstash Ratelimit) на уровне user+IP для `/api/chat`
- Sentry PII-scrubbing: не логировать полные тексты сообщений
- Webhook endpoints не должны падать при невалидном input — всегда `200 OK` с телом ошибки

## Регионы и задержки
- Vercel: `fra1` (Frankfurt)
- Supabase: EU (Frankfurt или Dublin)
- Cloudflare перед `/chat` — при необходимости защиты от ботов (BotID / Turnstile)
