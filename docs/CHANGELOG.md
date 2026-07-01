# Changelog

Все заметные изменения проекта. Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), секции по датам milestone'ов (semver-версии пока не выпускаются, `package.json` остаётся `0.0.1` до публичного релиза).

Подробный старый changelog (велся до 2026-06-10) — в истории git: `git show d9a1cb3:CHANGELOG.md`.

---

## 2026-07-01 — Реферальная программа: каркас выплат (Этап E1)

### Added

- **Каркас выплат партнёрам** (mock-исполнитель, движения денег НЕТ). Чистое ядро `packages/types/src/referral-payout.ts`: способы `card_rub`/`crypto_usdt`, комиссия вывода `computePayoutFee` (3.5% карта / 1% крипта, floor, удержание из брутто), маскирование PAN `maskPan` + отсев `isValidLuhn` (**CVV не собираем** — для выплаты не нужен, PCI-запрет), схемы реквизитов `payoutDestinationInput→Stored` (полный PAN не хранится/не логируется), машина статусов заявки `PAYOUT_ALLOWED_TRANSITIONS`.
- Миграция `0016`: enum `referral_payout_method` + колонки `method`/`fee_usd_cents` в `referral_payouts` (nullable). Применена к общей БД.
- `transitionReferralPayout` (условный UPDATE `requested→processing→paid|rejected`, `settled_at` на терминале). `PayoutExecutor` + `MockPayoutExecutor` + чистая оркестрация `settlePayout` (`apps/web/lib/referral/payout-executor.ts`). `requestReferralPayout` + `POST /api/cabinet/referral` принимают опциональные реквизиты.
- Тесты: types 91 (+19), web 224 (+6).

### Decided

- **D-REF-6 частично** (владелец, 2026-07-01): выплаты в рублях (карта) ИЛИ крипте (USDT), комиссия вывода 3.5% / 1%, для карты собираем только номер + ФИО (без CVV). Открыто: кто исполняет выплату (payout-API L&P?) + сеть USDT — реальный `PayoutExecutor` ждёт этого.

## 2026-07-01 — Реферальная программа: прогрессия статусов (Этап C)

### Added

- **Месячный крон `referral-rollup`** (1-е число, 02:00 UTC): прогрессия партнёров — храповик статусов (пороги $500/$2000/$5000, фиксация ставки L1 навсегда), бонусы достижения ($50/$150) / спринт «10+ новых активных» ($30) / серия ($25/$75/$200 за 3 мес. подряд), спринт-буст (+1% при ≥150% порога), командный множитель (L2 2%→2.5%), уведомления партнёру в бот. Чистое ядро `planMonthlyProgression` (`@oplati/types`); идемпотентность на партнёра-за-месяц — `PK(user_id, month)`.
- Таблица `referral_monthly_stats` (миграция `0015`, RLS) — агрегаты прогрессии. Применена к общей БД.

### Changed

- UI-терминология партнёрской программы: **«круг» → «статус»** (идентификаторы кода/БД остались `circle`/`current_circle`).
- `CLAUDE.md` + `docs/architecture.md` актуализированы: добавлена реферальная программа, поправлен статус PaySpace (включён на проде), списки кронов (7) и таблиц (16).

> **Гэп:** milestone'ы 2026-06-11…06-30 (реферальные сеть/ledger/кабинет — Этапы A/B/D; прод-запуск 06-19; PaySpace go-live) в этот changelog не бэкфилл'ены — история в git и `PLAN.md`/`SPEC.md`.

## [Unreleased] — 2026-06-10

### Changed

- **Документация пересобрана с нуля.** Старая спецификация (24 файла в `docs/`, спека-first workflow) и корневые md удалены; ai-factory (22 скилла + `.ai-factory/` + `.ai-factory.json`) удалён. Источник правды теперь — код + `CLAUDE.md`. Новая `docs/`: `architecture.md` (архитектура и устройство кодовой базы), `database.html` (как работает БД), этот changelog.
- Решение: Vercel AI SDK и токен-стриминг в веб-чате **не внедряем** (чат целевой, короткие ответы; свой tool-loop работает в проде на обоих каналах).

## 2026-06-10 — Веб-чат «Оплатишка»

### Added

- **Chat-first веб-чат** на главной странице: комикс-UI (pop-art/halftone, живой маскот), панель заказа, штамп «ОПЛАЧЕНО» (`components/chat/`, `components/comic/`, skill `oplatishka-design`).
- API веб-чата: `/api/chat` (тот же `runAgent()`, что у Telegram — один агент на оба канала; ответ JSON-ом), `/api/chat/history`, `/api/chat/clear`; cookie-сессия (`lib/chat/`).
- `/api/orders/confirm` и `/api/orders/status` — подтверждение и статус заказа из веб-UI.
- Graceful degradation: при недоступных Anthropic/БД чат отвечает понятным текстом, не 500.

## 2026-06-09 — Платежи Love&Pay end-to-end

### Fixed

- **Реальный контракт webhook L&P снят живым вызовом** (discovery): событие `invoice.paid`, id в `data.id`, заголовка `X-Webhook-Event` нет. Тестовая панель кабинета L&P шлёт фейковый формат — ей доверять нельзя. Первый платёж проведён e2e на dev: заказ `ORD-P8S1F` → `paid`.
- `confirm_order` теперь self-call'ит `/api/payments/create` в свой же deployment (а не на `APP_URL`) — иначе preview-деплои били в prod.

### Added

- **Telegram-уведомление клиенту об успешной оплате** (из webhook-обработчика).
- Guards + discovery-лог в webhook L&P для безопасного снятия контракта.

### Decided

- Ротация webhook-секрета L&P — решено не делать (владелец).

## 2026-06-02 — MVP: агент с памятью и tools + фикс пустой БД

### Added

- **AI-агент v2**: полный tool-loop (`runAgent`) с tools `web_search` / `search_catalog` / `propose_order` / `confirm_order` / `request_human`; память диалога (`loadRecentMessages` перед вызовом); приём заказов на **любой** сервис через `customDescription` (не только каталог).
- **Интеграция Love&Pay**: клиент, HMAC-подпись, создание инвойса, webhook-обработчик (+ Vitest-тесты `lib/loveandpay/`).
- **Cron-джобы (Vercel Cron)**: `poll-payment`, `expire-payments`, `renewal-reminder`, `recycle-cards`, `keepalive`. Требуют `CRON_SECRET`; работают только на production-деплое.
- **Каркас фазы карт PaySpace**: таблица `cards` (enum `active/idle/recycled`), репозиторий, клиент `lib/pay-space/` (`createCard`/`topupCard`/`getCard`), job `issue-card` с guard'ом `skipped_no_paypace` (выпуск выключен без env-ключей).
- `db:migrate` — применение полного набора миграций по журналу (в отличие от `db:push`, который диффит schema.ts).

### Fixed

- **Post-mortem «амнезия бота»**: боевая Supabase ушла в auto-pause и потеряла public-схему → все DB-вызовы падали → молчаливая деградация в `runAgentNoTools` без истории. Восстановлено `restore_project` + 7 миграций через `drizzle-kit migrate`; добавлен `keepalive`-cron и heartbeat-алерт в Sentry.

## 2026-05-17 — Расширение схемы БД

### Added

- 5 новых таблиц: `services` (публичный каталог, без RLS), `orders` (CHECK `orders_service_or_custom`), `order_events` (append-only audit log), `payments` (`UNIQUE(provider, provider_ref)` — идемпотентность webhook'ов), `attachments`. 5 enum'ов, включая `order_status` (13 значений). Все суммы — `integer` в минимальных единицах валюты.
- State machine заказа: `allowedTransitions` + `transitionOrder()` — единственная точка смены статуса.
- Идемпотентный seed каталога (10 сервисов, UPSERT по `slug`).

## 2026-04-30 — Persist диалогов + preview-деплой

### Added

- Repository-функции `getOrCreateUserByTelegramId` (raw-SQL upsert), `getOrCreateActiveConversation`, `appendMessage` (append-only).
- `handle-update.ts` синхронно пишет диалог в Supabase с graceful degradation на ошибках БД.
- API-роуты запиннены в `fra1` (`preferredRegion`), preview-окружение с отдельным dev-ботом `@dev_test_podpiska_bot`.

## 2026-04-28 — Базовая схема БД

### Added

- Таблицы `users`, `staff`, `conversations`, `messages` в Drizzle + RLS; миграции forward-only.

## 2026-04-27 — Telegram webhook + AI v1

### Added

- `/api/bot`: grammY webhook с проверкой `X-Telegram-Bot-Api-Secret-Token`; диспатч `/start` / текст; разбивка ответов по 4096 символов.
- Первая интеграция с Anthropic (`runAgentNoTools`, без tools).
- Два окружения Vercel (Production + Preview) с раздельными ботами.

## 2026-04-22 — Каркас проекта

### Added

- Монорепа pnpm + Turborepo: `apps/web` (Next.js 16, Tailwind v4, Sentry с PII-скраббером, pino, Zod-валидация env, Supabase-клиенты, `/api/health`) + пакеты `@oplati/types`, `@oplati/db`, `@oplati/agent` со строгими границами импортов.
- GitHub Actions: typecheck, lint, tests, security.
