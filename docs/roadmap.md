# Roadmap

## Sprint 1 — Скелет и AI-диалог (MVP-1)

**Цель:** бот отвечает в Telegram как AI-консультант, сохраняет историю.

- [ ] Turborepo + pnpm workspaces, пакеты `agent`, `db`, `types`
- [ ] Next.js 16 app с `/api/bot` (grammY webhook, проверка secret-token)
- [ ] Supabase проект, Drizzle миграции: `users`, `conversations`, `messages`
- [ ] Agent v1: Claude + системный промпт консультанта, БЕЗ tools
- [ ] `/start`, общение, история в БД
- [ ] Sentry подключён
- [ ] Deploy на Vercel (preview через `vercel --prod=false`)

**DoD:** заводим беседу → AI отвечает → история видна в Supabase Table Editor.

## Sprint 2 — Заказ, оплата, оператор

**Цель:** полный цикл от диалога до завершённого заказа.

- [ ] Таблицы `services`, `orders`, `payments`, `attachments`, `staff`, `order_events`
- [ ] Seed каталога: Claude, ChatGPT, Netflix, Spotify, Airbnb, YouTube Premium, Discord Nitro, Midjourney, LinkedIn Premium, Apple услуги — с флагом `requires_kyc`
- [ ] State machine заказа (функции-переходы + запись в `order_events`)
- [ ] Agent tools: `search_catalog`, `propose_order`, `confirm_order`, `request_human`
- [ ] Платёжные провайдеры: YooKassa (RUB/СБП) + CryptoBot (USDT)
- [ ] Payment webhooks с HMAC-проверкой + идемпотентностью
- [ ] Handoff в Telegram-группу операторов через forum-topics
- [ ] Supabase Auth для `/admin`, RLS политики
- [ ] Минимальная админка: список заказов, карточка, «взять в работу», «подтвердить» (upload скрина)

**DoD:** реальный заказ: диалог → оплата через тестовый YooKassa → оператор получает topic → завершает → клиент видит подтверждение.

## Sprint 3 — Веб-чат и production-ready

**Цель:** резервный канал + готовность к реальному трафику.

- [ ] `/chat` страница с `useChat` (AI SDK), стриминг
- [ ] Идентификация веб-юзера: cookie-session + подтверждение через SMS/email-код
- [ ] Связывание веб-юзера с Telegram-юзером по явной команде в боте
- [ ] Trigger.dev задачи: `poll-payment`, `expire-payments`, `alert-slow-fulfillment`
- [ ] Supabase Realtime в админке (новые заказы/сообщения live)
- [ ] BotID / Cloudflare Turnstile на `/chat`
- [ ] Sentry + Logtail дашборды, алерты на SLA нарушения
- [ ] Production deploy, домен, SSL
- [ ] Runbook для операторов + супервизоров

**DoD:** продукт готов принимать трафик, есть on-call план.

## Backlog (после MVP)
- Автопродление подписок
- Реферальная программа и промокоды
- EN/KZ/UZ
- OCR паспорта для KYC (Claude Vision)
- Аналитика: воронка, cohort retention, LTV
- Интеграция с бухгалтерией партнёров
- Вынос worker в отдельный сервис (если Trigger.dev перестанет хватать)
- CSAT-опрос после завершения заказа
