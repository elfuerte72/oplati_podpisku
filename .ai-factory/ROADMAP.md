# Project Roadmap

> Telegram-бот + веб-чат для продажи иностранных подписок русскоязычным пользователям; AI-консультант Claude Opus 4.6 + 24/7 команда операторов через Telegram forum-topics.

Подробные Definition of Done каждого спринта и backlog → [`../docs/roadmap.md`](../docs/roadmap.md).

## Milestones

- [x] **Project bootstrap** — pnpm + Turborepo монорепа, каркасы `@oplati/{agent,db,types}`, ENV-шаблон, MCP-конфиг, полная документация в `docs/`
- [ ] **Next.js app `apps/web`** — инициализация приложения, Supabase-клиенты (browser+server), Sentry baseline
- [ ] **Telegram webhook + AI v1** — `/api/bot` на grammY с проверкой secret-token, Claude без tools, системный промпт консультанта
- [ ] **Базовая схема БД** — `users`, `conversations`, `messages` в Drizzle, миграция применена через `db:push`
- [ ] **Preview-деплой (Vercel fra1)** — end-to-end smoke: `/start` → AI-ответ → запись в Supabase
- [ ] **Расширение схемы БД** — `services`, `orders`, `payments`, `attachments`, `staff`, `order_events` + seed каталога (Claude, ChatGPT, Netflix, Spotify, Airbnb, YouTube Premium, Discord Nitro, Midjourney, LinkedIn Premium, Apple) с флагом `requires_kyc`
- [ ] **State machine заказа + AI tools** — атомарные переходы с записью в `order_events`; tools `search_catalog`, `propose_order`, `confirm_order`, `request_human`
- [ ] **Интеграция платежей** — YooKassa (RUB/СБП) + CryptoBot (USDT), HMAC-валидация webhook, идемпотентность по `(provider, provider_ref)`
- [ ] **Handoff оператору** — Telegram forum-topics (один topic = один заказ), прокси сообщений пользователь ↔ оператор, команда `/ai_back`
- [ ] **Минимальная админка** — Supabase Auth + RLS, список/карточка заказа, «взять в работу», «подтвердить» (upload скриншота в Supabase Storage)
- [ ] **Веб-чат `/chat`** — Vercel AI SDK `useChat` со стримингом SSE, Upstash Ratelimit (user+IP), BotID/Turnstile
- [ ] **Идентификация веб-юзера + связывание с Telegram** — cookie-session, SMS/email-код, команда в боте для связывания
- [ ] **Фоновые задачи (Trigger.dev)** — `poll-payment`, `expire-payments`, `alert-slow-fulfillment`, `handoff-request`, `fulfillment-complete`
- [ ] **Realtime в админке** — Supabase Realtime для live-обновлений новых заказов/сообщений
- [ ] **Production-ready** — домен + SSL, Sentry дашборды и алерты на SLA, runbook оператора, on-call план

## Backlog

Список пост-MVP (автопродление, рефералка, EN/KZ/UZ, OCR KYC, аналитика, CSAT и др.) → [`../docs/roadmap.md`](../docs/roadmap.md#backlog-после-mvp).

## Completed

| Milestone | Date |
|---|---|
| Project bootstrap | 2026-04-22 |
