# Telegram Mini App — личный кабинет клиента

> **Обновление 2026-07-02 (реализовано и в проде).** Этот файл — исходный план (фазы/чек-боксы/открытые вопросы ниже — исторические). Фактическое состояние — источник правды в `CLAUDE.md`. Ключевые отличия от плана: кабинет = «оплатить подписку» (кнопочный каталог `CatalogView` внутри мини-аппа, action `propose`) + карта + партнёрка; **списка заказов (истории покупок) в UI НЕТ**; вход — inline-меню `/start` (web_app «Открыть приложение»), Menu Button (☰) отключён; реферальный захват из мини-аппа через `initData.start_param` (`?startapp=ref_`); Mini App зарегистрирован в BotFather (`/newapp`, short name `pay`).

**Статус:** реализовано (2026-06-16, ветка `dev`); остаётся приёмка — Menu Button в @BotFather + smoke-тест подписи на dev-боте.
**Scope (согласован с владельцем):** просмотр + действия; карты — только `pan_masked` + статус + баланс.
**Где живёт:** route `/cabinet` в существующем `apps/web` (отдельный деплой/проект НЕ нужен).
**Принятые решения:** D1 — TTL `auth_date` 24 ч; D2 — маршрут `/cabinet`; D3 — Menu Button; D4 — платёжная ссылка через `WebApp.openLink`.

## Статус реализации (2026-06-16)

Все три фазы написаны и проходят `typecheck` + `lint` + `vitest` (91 тест, из них 12 на
валидацию `initData`) + production-build (`/cabinet` и `/api/cabinet` собираются).

Файлы:
- `packages/types/src/telegram-webapp.ts` — Zod-схема `initData.user`.
- `apps/web/lib/telegram/init-data.ts` (+ `.test.ts`) — HMAC-валидация, TTL 24 ч, timing-safe.
- `packages/db` — `getOrdersByUserId`, `getOrderEventsByOrderId`, `findPaymentsByOrderId`,
  `findCardsByUserIdForCabinet`, `getUserProfileById`, `getServicesByIds` (+ barrel).
- `apps/web/lib/cabinet/` — `auth.ts` (resolveCabinetUser), `read.ts` (snapshot/detail +
  мапперы), `actions.ts` (pay/repeat/operator с ownership), `types.ts` (view-контракт).
- `apps/web/app/api/cabinet/route.ts` — POST, discriminated union по `action`, rate-limit
  по `telegram_id`.
- `apps/web/app/cabinet/page.tsx` + `apps/web/components/cabinet/*` — UI (SDK-loader,
  client-API c Zod-разбором, список/детали заказа, карты, профиль; комикс-стиль).

**Единственное, что не проверено кодом, — соответствие HMAC живому `initData` Telegram**
(правило проекта: контракт подтверждается живым вызовом). Это снимается smoke-тестом dev-бота
(см. §7). Если подпись не сойдётся — наиболее вероятная причина в поле `signature`
(подробности в шапке `init-data.ts`).

---

## 1. Зачем и почему это просто

Mini App — это веб-страница, открываемая внутри Telegram. Она показывает клиенту его
заказы, платежи, карты и профиль. Telegram требует один HTTPS-URL (настраивается в
@BotFather как Menu Button), **не** отдельную ссылку под каждого пользователя.

**Ключевой инсайт — авторизация решается «бесплатно».** Текущий веб-чат не знает, кто за
ним сидит, поэтому построена машинерия привязки: `link_tokens`, deep-link
`t.me/<bot>?start=link_<token>`, `consumeLinkToken`, merge двух `users`-строк, поллинг
статуса (`apps/web/app/api/auth/telegram/link/`, `apps/web/lib/telegram/handle-update.ts`).

В Mini App этого **не нужно**. Страница получает `window.Telegram.WebApp.initData` —
подписанные токеном бота данные с `telegram_id`. Сервер валидирует подпись (HMAC-SHA256) и
сразу знает пользователя. Личность первична и гарантирована: резолвим клиента напрямую через
существующий `getOrCreateUserByTelegramId(telegramId)`. Линк-токены и cookie-сессии в Mini App
не участвуют.

---

## 2. Что показываем (из текущей схемы БД, новых таблиц не требуется)

| Раздел | Источник | Поля |
|---|---|---|
| Список заказов | `orders` | `shortId`, `status`, `amountRub`, сервис, `createdAt` |
| Детали заказа | `orders` + `order_events` | таймлайн «создан → оплачен → выдан» |
| Платежи | `payments` | сумма, статус, дата |
| Карты | `cards` | **только `panMasked`** + `status` + `balanceUsdCents` |
| Профиль | `users` | `displayName`, `phone`, `email` |

---

## 3. Поток данных

```
Telegram webview
   │  открывает /cabinet (Menu Button из BotFather)
   ▼
app/cabinet/page.tsx  ──грузит──►  telegram.org/js/telegram-web-app.js
   │  клиент берёт window.Telegram.WebApp.initData (raw query-string)
   │  POST /api/cabinet  (initData в теле или заголовке Authorization: tma <initData>)
   ▼
app/api/cabinet/route.ts
   │  1. validateInitData(initData, TELEGRAM_BOT_TOKEN)  ← HMAC, см. §6
   │  2. getOrCreateUserByTelegramId(telegramId) → userId
   │  3. репозитории: заказы / платежи / карты (admin-клиент + фильтр по userId)
   ▼
JSON клиенту → рендер
```

`TELEGRAM_BOT_TOKEN` уже в `apps/web/lib/env.ts` и автоматически разный на окружениях
(prod-токен на production, dev-токен на preview — как webhook-secret). Валидация подписи
поэтому «из коробки» работает с правильным ботом без доп. конфигурации.

---

## 4. Фазы

### Фаза 1 — фундамент (read-only ядро) ◀ начинаем отсюда

Самое тонкое — безопасность. Цель фазы: открыть кабинет в dev-боте и увидеть свой список
заказов.

- [ ] **`apps/web/lib/telegram/init-data.ts`** — валидация `initData`:
  - HMAC-SHA256 по токену бота (алгоритм — §6);
  - проверка свежести `auth_date` (отклонять старше N часов, предложить 24 ч);
  - Zod-схема распарсенного `user` (`id`, `first_name`, `last_name?`, `username?`,
    `language_code?`) — в `@oplati/types`;
  - сравнение хэшей — **timing-safe** (переиспользовать существующий helper из
    `apps/web/lib/security/`, см. тест `security/timing-safe`);
  - **подтвердить алгоритм живым `initData`** (правило проекта: не доверять контракту до
    живого вызова) — захватить реальный `initData` из открытого Mini App, зафиксировать в
    unit-тесте.
- [ ] **`getOrdersByUserId(db, userId)`** — новая функция в
  `packages/db/src/repositories/orders.ts` (сейчас есть только `getOrderById` /
  `getOrderByShortId`). Сортировка по `createdAt desc`, лимит.
- [ ] **`apps/web/app/api/cabinet/route.ts`** — POST: валидация → резолв `userId` → список
  заказов. Webhook-style: ошибки в теле, не 500. Rate-limit по `telegram_id` (переиспользовать
  `apps/web/lib/ratelimit.ts`) ДО запросов к БД.
- [ ] **`apps/web/app/cabinet/page.tsx`** + client-компонент: грузит `telegram-web-app.js`,
  шлёт `initData`, рисует список заказов со статусами. UI в комикс-стиле (skill
  `oplatishka-design`). `Telegram.WebApp.ready()` + `expand()`.
- [ ] **@BotFather** — Menu Button → URL кабинета, в обоих ботах (prod + dev). См. §7.

### Фаза 2 — детали заказа, карты, профиль

- [ ] Экран одного заказа: таймлайн из `order_events`, платежи по заказу, карта
  (`panMasked` + статус + баланс).
- [ ] Новые функции репозиториев при необходимости: `getOrderEvents(orderId)`,
  `findPaymentsByOrderId(orderId)` (сейчас в `payments.ts` есть только
  `findPaymentByProviderRef`); карты — `findActiveByUserId` уже есть.
- [ ] Профиль: `displayName` / `phone` / `email` из `users`.

### Фаза 3 — действия (каждое с проверкой ownership)

Переиспользуют существующий код; **обязательна** проверка `order.userId === userId` — как уже
делают callback-хендлеры бота (`handleOrderActionCallback` в `handle-update.ts`).

- [ ] **Оплатить незавершённый заказ** (`ready_for_payment` / `pending_payment`) →
  `confirmOrder({ orderId, userId })` из `apps/web/lib/tool-handlers/confirm-order.ts` →
  вернуть `paymentUrl`. Открывать ссылку через `Telegram.WebApp.openLink` / `openInvoice`.
- [ ] **Повторить заказ** → `proposeFromCatalog(...)` из `apps/web/lib/catalog/propose.ts`
  (взять сервис/тариф из прошлого заказа).
- [ ] **Запросить оператора** → событие `handoff_requested` (как делает `request_human`).

---

## 5. Что переиспользуем, а что пишем заново

**Новый код — только два места:** валидация `initData` (§6) и UI-страницы кабинета.
Всё остальное — существующие репозитории и tool-handler'ы:

- `getOrCreateUserByTelegramId` — резолв клиента;
- `confirmOrder`, `proposeFromCatalog` — действия (Фаза 3);
- `transitionOrder` — единственный путь смены статуса заказа (инвариант);
- `ratelimit.ts`, timing-safe helper, `childLogger`, `Sentry` — обвязка.

Линк-токены, cookie-сессии, гейт `telegram_link_required` в Mini App неактуальны — у
пользователя всегда есть `telegram_id`.

---

## 6. Валидация `initData` (критично для безопасности)

Алгоритм (официальная дока Telegram WebApp — **подтвердить живым `initData` перед тем как
доверять**):

1. Распарсить `initData` как query-string → пары `key=value`.
2. Отделить `hash`.
3. `data_check_string` = оставшиеся пары, отсортированные по ключу, склеенные `key=value`
   через `\n`.
4. `secret_key = HMAC_SHA256(key="WebAppData", message=<bot_token>)`.
5. `computed_hash = hex(HMAC_SHA256(key=secret_key, message=data_check_string))`.
6. Сравнить `computed_hash` с `hash` — **timing-safe**.
7. Проверить `auth_date` на свежесть; отвергнуть протухшие.

Без валидной подписи — `401`/отказ, никаких данных. `initData` нельзя доверять как обычному
query-параметру: клиент может его подделать, подпись — единственная гарантия.

---

## 7. Чек-лист выкатки

**Vercel env:** `TELEGRAM_BOT_TOKEN` уже задан в обоих окружениях (валидация подписи берёт его
автоматически). Новых обязательных env нет. `APP_URL` уже есть — из него строим URL кабинета.

**@BotFather (оба бота):**
- prod `@test_prodipsa_bot` → Menu Button → `https://oplati-podpisku-web.vercel.app/cabinet`;
- dev `@dev_test_podpiska_bot` → Menu Button → preview-URL ветки `/cabinet`.
- (Опционально) inline-кнопка `web_app` в приветствии и/или `t.me/<bot>?startapp=` deep-link.

**Vercel Deployment Protection** — уже Disabled (нужно, иначе Telegram webview получит `401`
от обвязки Vercel до нашего кода).

---

## 8. Тестирование

- Unit: `validateInitData` — валидный/протухший/подделанный `hash`, протухший `auth_date`
  (Vitest в `apps/web`, рядом с `security/timing-safe`). Зафиксировать **реальный** `initData`.
- Unit: `getOrdersByUserId` — фильтрация по `userId`, сортировка.
- Ownership: действия Фазы 3 на чужом `orderId` → отказ (как у callback-хендлеров).
- Smoke: открыть кабинет в dev-боте, проверить список заказов и каждое действие.

---

## 9. Инварианты (не нарушать)

- **Полные `pan`/`cvc` в Mini App не отдаём** — только `pan_masked`. Полные реквизиты
  уходят клиенту единственным путём — Telegram-сообщением (инвариант из CLAUDE.md).
- **State-переходы только через `transitionOrder()`** — действия не трогают `orders.status`
  напрямую.
- **`order_events` append-only.**
- **Zod на границе** — `initData` и тело запроса парсятся схемой.
- **Ownership** — каждое действие сверяет `order.userId === userId`.
- **Не выдумывать контракт** — алгоритм подписи `initData` подтвердить живым вызовом.

---

## 10. Открытые вопросы

- **D1.** TTL свежести `auth_date` — 24 ч или короче (баланс «не разлогинивать» vs. защита от
  переигровки старого `initData`)?
- **D2.** Маршрут — `/cabinet` (предложено) или `/app`?
- **D3.** Точка входа: только Menu Button, или ещё inline-кнопка в приветствии бота и
  deep-link `?startapp=`?
- **D4.** Открытие платёжной ссылки L&P из webview — `openLink` (внешний браузер) vs.
  `openInvoice` (нативный Telegram-флоу). Проверить, что L&P-ссылка корректно открывается из
  Telegram.
