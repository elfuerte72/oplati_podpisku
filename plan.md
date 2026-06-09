# План: завершить автоматизацию оплат Love&Pay (webhook)

> Цель фазы — чтобы заказ **сам** переходил `pending_payment → paid` (и `→ expired/cancelled`),
> когда Love&Pay сообщает результат оплаты. Без ручного вмешательства, идемпотентно,
> с подстраховкой на потерянный webhook. Проверено end-to-end через dev-бота.

**Дата:** 2026-06-05 · **Ветка:** `dev` · **Провайдер:** Love&Pay (RUB/СБП)

---

## Статус реализации (обновлено 2026-06-08)

**Сделано в коде** (typecheck + 20 тестов зелёные):

- ✅ **Задача 4** — guard в `issue-card.ts`: без `PAYSPACE_*` заказ остаётся в `paid`
  (событие `job.issue_card.skipped_no_paypace` + Sentry warning), не падает в `failed`.
  Добавлен `isPaySpaceConfigured()` в `lib/pay-space/index.ts`.
- ✅ **Задача 8 (код)** — гард 500 ₽ в `/api/payments/create` (`LOVEANDPAY_MIN_AMOUNT_RUB`,
  422 `below_min_amount` до вызова L&P); парсер плоских ошибок L&P в `client.ts`;
  `docs/payments.md` переписан под Love&Pay.
- ✅ **Задача 1 (механизм)** — discovery-лог в webhook'е под флагом
  `LOVEANDPAY_WEBHOOK_DEBUG=1` (логирует реальные заголовки + rawBody ДО проверок,
  читая тело один раз). Снимать руками не нужно — выключается env-флагом.
- ✅ **Задача 7 (юнит)** — добавлены тесты: terminal `cancelled` (handlers) и плоский
  парсер ошибок (client). Идемпотентность paid/expired и подпись уже покрыты.
- ✅ **Задача 6 (код)** — подтверждено: `authorizeCron` читает `CRON_SECRET ?? CRON_TOKEN`
  напрямую из `process.env` (Vercel Cron шлёт `Bearer` сам). Задокументировано в `.env.example`.

**Осталось на твои ручные действия** (кабинет L&P / Vercel / реальный платёж):

- ⬜ **Задача 2** — задать `LOVEANDPAY_WEBHOOK_SECRET` в Vercel Preview + redeploy.
- ⬜ **Задача 3** — зарегистрировать webhook-URL в кабинете L&P.
- ⬜ **Задача 1 (discovery)** — выставить `LOVEANDPAY_WEBHOOK_DEBUG=1`, провести
  реальный платёж 500 ₽, снять контракт по логам, сверить со схемами, снять флаг.
- ⬜ **Задача 5** — E2E на dev (реальная оплата → `paid`).
- ⬜ **Задача 6 (prod)** — `CRON_SECRET` + `LOVEANDPAY_*` на Production + smoke.
- ⬜ **Задача 8 (Vercel)** — починить «все Preview» override `LOVEANDPAY_SECRET_KEY`.

---

## Definition of Done

- [ ] Реальная оплата через dev-бота на **500 ₽** автоматически переводит заказ в `paid` (без рук).
- [ ] Повторный webhook с тем же `provider_ref` **не** даёт двойной переход (идемпотентность).
- [ ] `invoice.expired` / `invoice.cancelled` корректно закрывают заказ.
- [ ] Невалидная подпись / чужой запрос → `200 OK` + Sentry, заказ не трогается.
- [ ] Подстраховка `poll-payment` работает там, где реально крутятся cron'ы (production).
- [ ] Граница с выпуском карты (PaySpace) не ломает платёжную фазу: если PaySpace не настроен —
      заказ остаётся в `paid` (ручной fulfillment), а не падает в `failed`.
- [ ] `docs/payments.md` приведён к Love&Pay (сейчас описывает YooKassa/CryptoBot).

**Вне scope этой фазы:** сам выпуск карты PaySpace (отдельная фаза «fulfillment»). Здесь — только
довести оплату до статуса `paid` достоверно.

---

## Где мы сейчас (факты из кода)

| Что | Статус | Источник |
|---|---|---|
| Создание счёта (ссылка + СБП-QR) | ✅ работает на preview | `app/api/payments/create/route.ts` |
| Webhook-обработчик (paid/expired/cancelled) | ✅ код есть, идемпотентный | `app/api/payments/loveandpay/route.ts` + `lib/loveandpay/handlers.ts` |
| `LOVEANDPAY_WEBHOOK_SECRET` | ❌ пуст во всех окружениях → роут молча отдаёт `200 skipped:not_configured` | `route.ts:41-45` |
| Webhook URL зарегистрирован у L&P | ❌ нет | кабинет L&P |
| Контракт webhook (заголовки/подпись/имена событий) | ⚠️ **предполагаемый, не подтверждён живым вызовом** | `packages/types/src/loveandpay.ts` (комментарий прямо это пишет) |
| Подстраховка `poll-payment` | ⚠️ код есть, но Vercel cron'ы идут **только на production**, а там нет L&P-ключей | `lib/jobs/poll-payment.ts`, `apps/web/vercel.json` |
| Выпуск карты после `paid` | ⚠️ `dispatchIssueCard` дёргается из webhook; без `PAYSPACE_*` падает в `paid → failed` | `lib/jobs/issue-card.ts:167` |

---

## Ограничения, которые надо держать в голове

1. **Webhook у L&P — глобальный на аккаунт.** В теле `POST /invoices` нет поля `callbackUrl` —
   значит URL задаётся один на весь аккаунт (как у Telegram-бота). Тестируем на preview →
   указываем webhook на dev-deployment; идём в прод → перенаправляем на prod. Одновременно — только один.
2. **Контракт webhook нельзя принимать на веру.** Если реальные заголовок/алгоритм подписи/имена событий
   отличаются от наших схем — `verifyWebhookSignature` вернёт `false` или Zod не распарсит, и роут тихо
   ответит `200 skipped`. Поэтому Задача 1 — **снять реальный контракт с живого webhook'а**, и только потом доверять.
3. **Деньги в L&P — в рублях, минимум счёта 500 ₽** (терминал KANYON). Ниже — `INTERNAL_ERROR`.
4. **Инвариант: webhook всегда `200 OK`.** Любая ошибка — в теле ответа + Sentry, не HTTP-кодом.

---

## Задачи

### 1. Снять реальный контракт webhook'а L&P (discovery — делать первой)
**Зачем:** убрать главный риск — что подпись/схема не совпадут и всё будет молча отклоняться.

- [ ] Временно добавить в начало `app/api/payments/loveandpay/route.ts` диагностический лог:
      все входящие заголовки + `rawBody` (целиком), **до** проверки подписи. (Секрет не логировать.)
- [ ] Задеплоить на dev-preview, зарегистрировать webhook на dev-URL (см. Задача 3).
- [ ] Провести один реальный тест-платёж на 500 ₽ через dev-бота, оплатить.
- [ ] По логам зафиксировать факт:
  - точное имя заголовка события (ожидаем `X-Webhook-Event`) и подписи (ожидаем `X-Webhook-Signature`);
  - алгоритм подписи: `HMAC-SHA256(webhookSecret, rawBody)`, кодировка hex vs base64;
  - имена событий (ожидаем `invoice.paid` и т.д.) и форму payload (`{event, data:{...}}`).
- [ ] Сверить с `packages/types/src/loveandpay.ts` (`loveAndPayWebhookEventSchema`, `loveAndPayWebhookData`)
      и `lib/loveandpay/sign.ts` (`verifyWebhookSignature`). Где расходится — поправить схему/верификацию.
- [ ] **Удалить диагностический лог** после подтверждения.

**Готово, когда:** в логах виден реальный webhook, и наши схемы ему соответствуют байт-в-байт.

---

### 2. Задать `LOVEANDPAY_WEBHOOK_SECRET` в Vercel
- [ ] Получить webhook-secret из кабинета L&P (или сгенерировать, если L&P даёт задать свой).
- [ ] Прописать `LOVEANDPAY_WEBHOOK_SECRET` в Vercel env → **Preview** (для теста на dev).
- [ ] **Redeploy** dev-preview (env вмораживается в деплой — без redeploy старый деплой не увидит секрет).
- [ ] Проверить: `GET /api/payments/loveandpay` больше не отвечает `skipped:not_configured`.

> Примечание: для прод — тот же секрет в **Production** + redeploy, но только когда будем выводить оплату на prod (Задача 6).

---

### 3. Зарегистрировать webhook URL в кабинете L&P
- [ ] В кабинете L&P указать URL webhook'а = `https://<dev-preview>/api/payments/loveandpay`.
- [ ] Зафиксировать в `docs/deployment.md` процедуру **перенаправления** webhook'а preview↔prod
      (по аналогии с тем, как делаем для Telegram-бота через `/api/admin/telegram-webhook`).
- [ ] (Если L&P поддерживает фильтр событий) подписаться минимум на `invoice.paid`, `invoice.expired`, `invoice.cancelled`.

**Готово, когда:** L&P реально стучится на наш endpoint (видно по логам из Задачи 1).

---

### 4. Граничный guard: не ломать платёжную фазу выпуском карты
**Проблема:** `processInvoicePaid` после `paid` синхронно дёргает `dispatchIssueCard → issueCard`.
Без `PAYSPACE_*` карта не выпустится и `issueCard` переведёт заказ `paid → failed` (`issue-card.ts:167`).
Тогда успешная оплата визуально выглядит как провал.

- [ ] В `lib/jobs/issue-card.ts`: если `PAYSPACE_*` не сконфигурирован — **не** падать в `failed`,
      а оставить заказ в `paid`, залогировать `issue_card.skipped_no_paypace` + Sentry-warning
      (заказ уйдёт в ручной fulfillment оператором).
- [ ] Убедиться, что путь `paid` без выпуска карты не нарушает `allowedTransitions`
      (`paid` — валидное «промежуточное» состояние, дальше переходит оператор/следующая фаза).

**Готово, когда:** оплата на dev доводит заказ строго до `paid` и там останавливается, без `failed`.

---

### 5. End-to-end тест на dev (главная проверка фазы)
- [ ] Оформить заказ через dev-бота на сумму ≥ 500 ₽, получить ссылку + QR.
- [ ] Реально оплатить.
- [ ] Убедиться по БД/логам: `payments.status` → `succeeded`, `orders.status` → `paid`,
      в `order_events` добавилась строка `payment_succeeded`.
- [ ] Бот уведомил пользователя об успешной оплате.

**Готово, когда:** весь путь от «оплатил» до `paid` прошёл без ручных действий.

---

### 6. Подстраховка `poll-payment` (на случай потерянного webhook'а)
**Контекст:** Vercel cron'ы выполняются **только на production**. На preview `poll-payment` сам не запустится.

- [ ] Подтвердить переменную авторизации cron'а: `authorizeCron` ждёт токен (`CRON_TOKEN`?), которого нет в `lib/env.ts`.
      Добавить в схему env и задать значение, либо подтвердить, что Vercel Cron шлёт `Authorization: Bearer` сам.
- [ ] Для среды, где крутятся cron'ы (production), обеспечить наличие L&P-ключей (`LOVEANDPAY_*`) —
      иначе `poll-payment` не сможет вызвать `getInvoice`.
- [ ] Ручной прогон: `GET /api/cron/poll-payment` с валидным токеном → `{ ok:true, processed, recovered }`.
- [ ] Smoke: оплатить счёт, но webhook искусственно «пропустить» (например, временно снять регистрацию) →
      убедиться, что poll-payment добивает заказ до `paid` с `recoveredViaPolling=true` + Sentry-warning.

---

### 7. Негативные кейсы и идемпотентность
- [ ] Двойной `invoice.paid` (повтор) → второй обрабатывается как `idempotent_skip`, без двойного перехода.
- [ ] `invoice.expired` → заказ `→ expired`, платёж `→ failed`.
- [ ] `invoice.cancelled` → заказ `→ cancelled`, платёж `→ failed`.
- [ ] Подпись с неверным секретом → `200` + `skipped:invalid_signature` + Sentry, заказ не тронут.
- [ ] `invoice.paid` без нашего `payment` в БД → `not_found` + Sentry-warning (не падаем).

---

### 8. Сопутствующее (можно параллельно)
- [ ] **Гард минимума 500 ₽** в `propose_order`/`confirm_order` — не давать создать счёт ниже лимита терминала.
- [ ] **Починить «все Preview» secret** `LOVEANDPAY_SECRET_KEY` — сейчас корректен только override для ветки `dev`;
      прочие preview-ветки держат битое значение (даёт `INVALID_SIGNATURE`).
- [ ] **`docs/payments.md` → Love&Pay.** Файл всё ещё описывает YooKassa/CryptoBot. По правилу проекта
      «docs — источник правды» расхождение с кодом надо устранить (или зафиксировать ADR).
- [ ] (Опц.) Парсер ошибок L&P в `lib/loveandpay/client.ts:185-201` понимает только вложенный
      `{success:false,error:{...}}`; плоский `{error,hint,code}` теряется как `HTTP_400`. Расширить — для читаемых логов.

---

## Риски

| Риск | Митигация |
|---|---|
| Реальный контракт webhook ≠ наши схемы → всё молча отклоняется | Задача 1 (снять живой контракт ДО доверия секрету) |
| Webhook глобальный на аккаунт → preview и prod конфликтуют за один URL | Документированная процедура перенаправления (Задача 3) |
| Cron'ы не идут на preview → ложное ощущение «подстраховка работает» | Тестировать poll-payment там, где cron реально крутится (Задача 6) |
| Выпуск карты роняет оплату в `failed` | Graceful-degradation guard (Задача 4) |
| Секрет L&P светился в чате ранее | Ротировать после стабилизации интеграции |

---

## Чеклист env к продакшену (когда выводим оплату на prod)

- [ ] `LOVEANDPAY_API_KEY`, `LOVEANDPAY_SECRET_KEY`, `LOVEANDPAY_BASE_URL` — добавить в **Production** (сейчас только Preview).
- [ ] `LOVEANDPAY_WEBHOOK_SECRET` — в **Production**.
- [ ] `INTERNAL_API_TOKEN` — в **Production** (нужен self-call `confirm_order → /api/payments/create`).
- [ ] `CRON_TOKEN` (если используется) — в **Production**.
- [ ] Webhook L&P перенаправлен на prod-URL.
- [ ] Redeploy production после всех env.
- [ ] (Следующая фаза) `PAYSPACE_*`, `COMMISSION_PERCENT` — для выпуска карт.
