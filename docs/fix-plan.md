# План исправлений по итогам код-ревью (2026-06-14)

Источник — полное ревью по трём направлениям: безопасность, целостность данных/БД, AI-агент и защита расходов. Находки сгруппированы в **кластеры задач** по приоритету. Внутри кластера фиксы связаны и их разумно делать вместе.

Легенда серьёзности: 🔴 critical · 🟠 high · 🟡 medium · 🟢 low.

> Хорошая новость: платёжный гейт, подпись L&P, идемпотентность платежей, ownership на вебе и серверные границы заказа сделаны правильно — обойти оплату через AI/инъекцию нельзя. Основные риски — операционные: гонки при выпуске карт, отсутствие rate-limit, fail-open авторизации.

## Статус реализации (2026-06-14)

**Реализовано и проверено** (`pnpm typecheck` + `pnpm lint` + `pnpm --filter web test` 59 тестов + `next build` — всё зелёное):

| Пункт | Что сделано |
|---|---|
| A1 | `claimPaymentSucceeded` — атомарный claim `pending→succeeded` (`payments.ts`); `processInvoicePaid` диспатчит issue-card только если claim вернул строку |
| A2 | recovery «зависших в paid» в cron `poll-payment` (гейт `isPaySpaceConfigured`); исправлен комментарий в `dispatcher.ts` |
| A3 | `transitionOrderDetailed` (флаг `transitioned`); `issueCard` claim'ит `paid→in_fulfillment` ДО топ-апа (at-most-once, без двойной траты) |
| B1 | `lib/ratelimit.ts` (Upstash sliding window) подключён в `/api/chat` (per-IP) и `/api/bot` (per-telegram_id) до роутера |
| B3 | комментарий бюджета приведён к реальности — rate-limit (B1) теперь существует и не зависит от Postgres |
| B4 | сквозной потолок web_search на один `runAgent` (`MAX_WEB_SEARCH_PER_RUN=3`) |
| C1 | `authorizeCron` fail-closed (пускает только `NODE_ENV=development`); `CRON_SECRET`/`CRON_TOKEN` в env-схеме |
| C2 | удалён discovery-флаг `LOVEANDPAY_WEBHOOK_DEBUG` и логирование тела webhook'а |
| C3 | Telegram callback `confirm`/`cancel` резолвит `userId` по нажавшему и проверяет владельца |
| C4 | оплата на нелегальный статус → `Sentry.captureException` (error), а не молчаливый warn |
| C5 | `lib/security/timing-safe.ts`; все secret-хедеры (telegram, internal, cron) сравниваются constant-time |
| D1 | правило про enum-миграции в `CLAUDE.md` |
| D2 | прояснена семантика `amountRubKopecks` (субтотал без комиссии) в контракте |
| D3 | базовые security-заголовки в `next.config.ts` (X-Frame-Options, nosniff, Referrer-Policy, HSTS) |
| D4 | `/api/health` больше не отдаёт окружение наружу |

**Требует действия владельца:** B1 заработает после провижининга Upstash Redis и `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` в env (Production + Preview + `.env.local`). До этого limiter fail-open (инертен). Аналогично C1: на проде задать `CRON_SECRET`.

**Сознательно НЕ делалось** (с обоснованием):
- **B3 «деградация в no-tools при недоступной БД»** — отклонено: форсить no-tools на каждый запрос во время блипа Supabase сломало бы основную функцию (tools) для всех легитимных юзеров. DB-независимый rate-limit (B1) закрывает риск расходов лучше и без этого побочного вреда.
- **B5 отдельный per-IP лимит на заказы** — покрывается B1 (rate-limit `/api/chat` по IP), отдельный счётчик избыточен.
- **D2 переименование поля `amountRubKopecks`** — рипл по контракту модели/UI ради косметики; ограничились doc-комментарием.
- **Idempotency-ключ топ-апа PaySpace** — нужен подтверждённый контракт PaySpace (блокер по CLAUDE.md). До него A3 даёт «at-most-once» (claim-first): редкий «claim сделан, инстанс умер до топ-апа» оставляет заказ в `in_fulfillment` для оператора — без двойной траты.

Ниже — исходный план с деталями каждого пункта.

---

---

## Кластер A — Деньги и выпуск карт (фаза 2) 🔴

Самый дорогой риск: реальная двойная трата и тихая потеря оплаченных заказов. Делать до включения выпуска карт.

### A1. 🔴 Двойной топ-ап карты при гонке webhook ↔ poll-payment
- **Где:** `apps/web/lib/jobs/issue-card.ts:61-152`, `apps/web/lib/loveandpay/handlers.ts:86-114`, `packages/db/src/repositories/payments.ts:118-156`
- **Проблема:** `markPaymentSucceeded` делает безусловный `UPDATE ... SET status='succeeded' WHERE id=?`. Webhook L&P и cron `poll-payment` могут зайти почти одновременно — оба прочитают `pending`, оба запустят выпуск карты → `topupCard` на PaySpace вызывается дважды.
- **Фикс:**
  1. Сделать переход платежа атомарным claim'ом: `UPDATE payments SET status='succeeded', ... WHERE id=? AND status='pending' RETURNING *`. Если вернулось 0 строк — это повтор, выходим **до** `dispatchIssueCard`/`dispatchPaymentConfirmed`.
  2. Сериализовать сам выпуск карты: advisory-lock `pg_advisory_xact_lock(hashtext(orderId))` вокруг issue-card, либо перенести топ-ап внутрь `transitionOrder(paid→in_fulfillment)` под тем же `FOR UPDATE`-локом.
- **Готово, когда:** два параллельных вызова `processInvoicePaid` для одного инвойса приводят ровно к одному `topupCard` (тест с искусственной гонкой).

### A2. 🟠 issue-card теряется при завершении инстанса — нет авто-recovery
- **Где:** `apps/web/lib/jobs/dispatcher.ts:25`, `apps/web/lib/jobs/poll-payment.ts:42-64`
- **Проблема:** `dispatchIssueCard` запускается через `setImmediate` (fire-and-forget). Если serverless-инстанс умрёт после ответа `200 OK`, но до завершения выпуска — заказ зависнет в `paid`. Комментарий «подстраховано poll-payment» **неверен**: poll берёт только платежи `status='pending'`, а оплаченный уже `succeeded` → issue-card никогда не переотработается.
- **Фикс (выбрать один):**
  - **Вариант 1 (предпочтительно):** отдельный recovery-cron «заказы в `paid` старше N минут → повторить issue-card» (идемпотентно, после A1).
  - **Вариант 2:** выпускать карту синхронно до ответа webhook'у (`maxDuration=30` это переживёт).
  - В любом случае — исправить вводящий в заблуждение комментарий в `dispatcher.ts`.
- **Готово, когда:** убитый между оплатой и выпуском заказ автоматически довыпускается без ручного вмешательства.

### A3. 🟠 Несогласованность баланса карты (5 не-атомарных операций)
- **Где:** `packages/db/src/repositories/orders.ts:260-268` (`setOrderCardId`), `packages/db/src/repositories/cards.ts:160-172` (`updateBalance`)
- **Проблема:** в `issueCard` идёт цепочка `topupCard` → `updateBalance` → `setOrderCardId` → 2× `transitionOrder` = 4 транзакции + внешний вызов. Сбой посередине оставляет рассогласование; `updateBalance` (`balance + delta`) не защищён от повторного применения той же дельты.
- **Фикс:** привязать дельту баланса к `orderId`/invoice (идемпотентный ключ или поле `last_topup_order_id`), применять только если ещё не применена. Объединить топ-ап и переход в безопасную для ретрая единицу.
- **Готово, когда:** повторный запуск issue-card по тому же заказу не меняет баланс второй раз.

---

## Кластер B — Защита AI-расходов и от DoS 🔴

При падении Supabase сейчас не остаётся ни одного работающего слоя защиты расходов, кроме prepaid-баланса Anthropic.

### B1. 🔴 Нет per-user / per-IP rate-limit
- **Где:** `apps/web/app/api/chat/route.ts`, `apps/web/lib/telegram/handle-update.ts`; Upstash заявлен в `apps/web/lib/env.ts:117-119`, но нигде не импортируется.
- **Проблема:** единственный лимит расхода — глобальный дневной бюджет (≈$9/день). Один атакующий запросами «хочу оплатить netflix» (→ полный Sonnet + 2 web_search) кладёт сервис для всех легитимных юзеров. В вебе при отсутствии cookie создаётся новый `userId` на каждый запрос.
- **Фикс:** подключить уже заложенный в env Upstash Ratelimit (sliding window) **до** вызова `classifyMessage`:
  - веб (`/api/chat`) — per-IP;
  - бот (`/api/bot`) — per-`chat_id`/`telegram_id`.
- **Готово, когда:** один IP/чат не может сделать больше N запросов в минуту; превышение → понятный ответ, без вызова агента.

#### Реализация на Upstash

**Почему Upstash:** счётчик запросов должен быть общим для всех serverless-инстансов и **не зависеть от Postgres** (иначе при падении Supabase отвалится и защита расходов — находка B3). Upstash — Redis по HTTP, без постоянных соединений, pay-per-request; на объёме ~50 заказов/день укладывается в бесплатный тариф. Env-переменные `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` уже зарезервированы (`env.ts:117-119`) и редактируются в логах (`logger.ts:37`), но пакет не установлен и код не использует.

**Шаги:**
1. Завести Redis-базу в Upstash. Рекомендуемый путь — через **Vercel Marketplace** (Vercel → проект → Storage/Integrations → Upstash Redis): переменные окружения автоматически прописываются в Production и Preview. Альтернатива — регистрация на upstash.com и ручной ввод ключей в Vercel env + локальный `.env.local`.
2. Сверить имена переменных. `Redis.fromEnv()` ищет именно `UPSTASH_REDIS_REST_URL` и `UPSTASH_REDIS_REST_TOKEN`. Если интеграция создаёт другие имена (напр. с префиксом) — либо переименовать в Vercel, либо передать значения в `new Redis({ url, token })` явно.
3. `pnpm --filter web add @upstash/ratelimit @upstash/redis`.
4. Обёртка `apps/web/lib/ratelimit.ts`: sliding window (старт: веб 10/60 s per-IP, бот 20/60 s per-`chat_id` — подобрать по нагрузке), ключи `chat:${ip}` / `bot:${chatId}`.
5. Вызвать `ratelimit.limit(key)` в начале `/api/chat` и `/api/bot` **до** `classifyMessage`/`runAgent`. Превышение → веб `429` + понятный JSON; бот → короткий каннед-ответ, без вызова модели.
6. **Fail-open осознанно:** если сам Upstash недоступен — пропускать запрос (лучше пропустить, чем уронить сервис), но логировать в Sentry. Сделать выключатель по аналогии с `AI_ROUTER_DISABLED`.

**Что требуется от владельца (нельзя сделать из кода):**
- Создать Redis-базу в своём аккаунте Vercel/Upstash (нужен логин в аккаунт).
- Прописать `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` в Vercel env (Production + Preview) и в локальный `.env.local`. **Ключи в чат/коммиты не пастить** — только в env (правило безопасности проекта).
- Сообщить разработчику только **имена** переменных, если они отличаются от зарезервированных (значения не нужны — код читает их из env).

### B2. 🔴 Заявленный «WAF rate-limit» отсутствует в коде
- **Где:** нет `middleware.ts`, нет firewall-правил в `vercel.json`. Упоминается в `CLAUDE.md` и `docs/ai-cost-protection.md` как существующий слой.
- **Проблема:** защита, на которую ссылается аргументация fail-open в `budget.ts`, не версионируется и не воспроизводится на preview. Может быть молча снята в Dashboard.
- **Фикс:** либо реализовать B1 в коде (закрывает и это), либо честно пометить в доках, что rate-limit — ручная dashboard-настройка, и не ссылаться на неё как на гарантию.
- **Готово, когда:** документация соответствует реальности; защита воспроизводима из репозитория.

### B3. 🟠 Fail-open бюджета при недоступной БД отключает защиту расходов
- **Где:** `apps/web/lib/ai/budget.ts:98-112`
- **Проблема:** при падении Supabase (free-tier автопауза — реальный кейс) `isAiBudgetExceeded` ловит ошибку и возвращает `false`, `recordAgentUsage` глотает ошибку записи. Самый дорогой момент совпадает с моментом, когда защита выключена.
- **Фикс:** circuit-breaker — при N подряд ошибках чтения бюджета переходить в деградацию: `runAgentNoTools` (без дорогого web_search) или fail-closed. Per-IP rate-limit (B1) держать на Redis, не зависящем от Postgres.
- **Готово, когда:** недоступность БД не означает безлимитный расход на API.

### B4. 🟡 web_search не ограничен через итерации tool-loop
- **Где:** `packages/agent/src/index.ts:222`, `packages/agent/src/tools.ts:22`
- **Проблема:** `max_uses:2` — лимит Anthropic на один вызов API, а tool-loop делает до 6 итераций → де-факто потолок до 12 поисков на один `runAgent`.
- **Фикс:** ввести счётчик web_search через все итерации внутри `runAgent`, убирать `web_search` из `tools` после исчерпания (например, 3 на разговор). Подтвердить поведение `max_uses` по докам Anthropic.
- **Готово, когда:** один `runAgent` не делает больше заданного числа web_search независимо от итераций.

### B5. 🟡 Лимит ≤10 заказов/сутки обнуляется новой web-сессией
- **Где:** `apps/web/lib/tool-handlers/propose-order.ts:140`
- **Проблема:** считается per-`userId`, а в вебе `userId` пересоздаётся при отсутствии cookie. Telegram защищён (`telegram_id` стабилен), веб — обходится.
- **Фикс:** дополнить per-user лимит per-IP-лимитом на создание заказов в вебе (часть B1).

---

## Кластер C — Операционная безопасность 🟠

### C1. 🟠 Cron-endpoints fail-open вне production без `CRON_SECRET`
- **Где:** `apps/web/app/api/cron/poll-payment/route.ts:40-49` (`authorizeCron`, общая для всех 5 cron'ов)
- **Проблема:** если токен не задан, авторизация возвращает `true` на любом окружении кроме `VERCEL_ENV==='production'`. Preview публичен и шарит ту же Supabase/кабинет L&P, что и prod → любой может дёргать рециклинг карт, рассылку reminder'ов, опрос платежей. `CRON_SECRET` не объявлен в `lib/env.ts` (нет fail-fast).
- **Фикс:** `if (!token) return false;` везде; локальный smoke гейтить по `NODE_ENV==='development'`; добавить `CRON_SECRET` в Zod-схему env.

### C2. 🟠 `LOVEANDPAY_WEBHOOK_DEBUG` логирует все заголовки и сырое тело webhook'а
- **Где:** `apps/web/app/api/payments/loveandpay/route.ts:56-62`, env в `lib/env.ts:97-99`
- **Проблема:** при включённом флаге пишет `Object.fromEntries(req.headers)` + тело **до** проверки подписи; pino-redact этот объект не покрывает. Контракт L&P уже снят (2026-06-09) — discovery-флаг больше не нужен.
- **Фикс:** удалить флаг и блок discovery-логирования.

### C3. 🟡 Telegram callback `confirm`/`cancel` не проверяет владельца заказа
- **Где:** `apps/web/lib/telegram/handle-update.ts:616-708`
- **Проблема:** `orderId` берётся из `callback_data`, `confirmOrder` зовётся **без `userId`** → ownership-check пропускается. Защита держится только на неугадываемости UUID; Telegram не гарантирует неподделанный `callback_data`. Веб-путь сверяет владельца корректно — Telegram слабее.
- **Фикс:** резолвить `userId` по `cb.from.id` (`getOrCreateUserByTelegramId`) и передавать в `confirmOrder({ orderId, userId })`; для `cancel` сверять владельца перед `transitionOrder`.

### C4. 🟡 Оплата на нелегальный статус заказа проглатывается без алерта
- **Где:** `apps/web/lib/loveandpay/handlers.ts:86-106`, `158-172`
- **Проблема:** `OrderTransitionError` (оплата пришла на `cancelled`/`expired` заказ) логируется как `warn` без `Sentry.captureException`. Деньги получены, заказ не двинется, никто не узнает.
- **Фикс:** разделить случаи: `from === to` (noop, молча) vs настоящий запрещённый переход → `Sentry.captureException` уровня error + явный event.

### C5. 🟡 Секрет-хедеры сравниваются не timing-safe
- **Где:** `bot/route.ts:47`, `payments/create/route.ts:52`, `admin/telegram-webhook/route.ts:39`, `cron/*/route.ts:48`
- **Проблема:** используется `!==` (early-exit), тогда как подпись L&P корректно через `crypto.timingSafeEqual`. Непоследовательно.
- **Фикс:** единый хелпер `timingSafeCompare(a, b)` (с нормализацией длины) для всех секрет-хедеров.

---

## Кластер D — Мелочи и гигиена 🟡🟢

### D1. 🟡 `ALTER TYPE ... ADD VALUE` внутри транзакции миграции
- **Где:** `packages/db/migrations/0004_cooing_ricochet.sql:2-3`
- **Проблема:** хрупкий паттерн (на PG12+ новое значение нельзя использовать в той же транзакции). Прод-БД в порядке, но риск на будущее.
- **Фикс:** зафиксировать правило в `CLAUDE.md` (раздел «Миграции»): enum-расширения — отдельной миграцией, не смешивать с использованием значения.

### D2. 🟡 Округление комиссии / семантика `amountRubKopecks`
- **Где:** `apps/web/lib/tool-handlers/propose-order.ts:179-181`
- **Проблема:** арифметика в integer верна, но поле `amountRubKopecks` в `ProposeOrderResult` = субтотал без комиссии, а в заказ пишется total с комиссией — вводящее в заблуждение имя. Расчёт по live-rate, хранится квантованный снапшот (расхождение ≤1 копейки).
- **Фикс:** считать по сохранённому курсу либо задокументировать; прояснить/переименовать поле.

### D3. 🟢 Security-заголовки
- **Где:** `apps/web/next.config.ts` — нет `headers()`.
- **Фикс:** добавить `X-Frame-Options: DENY`/`frame-ancestors`, HSTS, базовый CSP для платёжного UI.

### D4. 🟢 Health-endpoint раскрывает окружение
- **Где:** `apps/web/app/api/health/route.ts:23-31` — отдаёт `VERCEL_ENV` без аутентификации.
- **Фикс:** убрать `env` из публичного ответа.

### D5. 🟢 Прочее
- Системный промпт уязвим к prompt-leak (`packages/agent/src/prompts.ts:93-94`) — без финансового ущерба, гейт форсится серверно. Принять как известный риск.
- `link/status` поллинг без rate-limit в коде — закроется B1.
- Merge при telegram-link оставляет висеть старый `link_tokens.web_session_id` — закроется TTL/`used_at`.

---

## Рекомендуемый порядок

1. **Кластер A** (A1+A2+A3) — главный денежный риск, обязательно до включения выпуска карт PaySpace.
2. **Кластер B** (B1 закрывает B2/B5 и смягчает B3) — защита от DoS-на-бюджет.
3. **Кластер C** (C1, C2 — быстрые; C3, C4, C5 — следом).
4. **Кластер D** — по остаточному принципу.

## Что НЕ доделано в ревью

Четвёртое направление — ревью логики и обработки ошибок (floating promises, `catch {}`, корректность HTTP-статусов, таймзоны cron, Zod `parse` vs `safeParse`) — было прервано и не выполнено. При необходимости до-запустить отдельно.
