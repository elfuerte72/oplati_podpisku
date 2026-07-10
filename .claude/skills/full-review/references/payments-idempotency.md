# Ось B — Платежи, идемпотентность webhook, границы заказов

Жёсткие инварианты из CLAUDE.md (разделы «Платежи», «Cron», «Архитектурные
инварианты» п.2/6, «Защита AI-расходов», Фаза 2 PaySpace). Деньги двигаются здесь —
любой пропуск = двойное списание, застрявший заказ или потерянный платёж.

## B1 · Идемпотентность webhook на уровне БД

- `payments`: `UNIQUE(provider, provider_ref)` + `INSERT ... ON CONFLICT DO NOTHING`.
  Повторный webhook не создаёт дубль и не даёт второй переход.
- Частичный `UNIQUE(order_id) WHERE status='pending'` — не более одного живого
  инвойса на заказ.
- ❌ Нарушение: `INSERT` платежа без `ON CONFLICT`; снятие/ослабление UNIQUE;
  создание второго pending-инвойса на заказ без учёта частичного индекса.

## B2 · Атомарный claim платежа

- `claimPaymentSucceeded` переводит `pending → succeeded` **одним условным
  `UPDATE`**; побочные эффекты (переход заказа, уведомление, начисления) выполняет
  **только победитель** гонки webhook ↔ cron poll.
- Anti-replay L&P держится на этом claim (подпись без timestamp/nonce).
- ❌ Нарушение: `SELECT ... затем UPDATE` вместо атомарного условного UPDATE;
  побочный эффект до/вне claim; побочный эффект выполняется всеми, а не победителем;
  claim не проверяет текущий статус в `WHERE`.

## B3 · Claim + переход в одной транзакции

- В `processInvoicePaid`: `claimPaymentSucceeded` и `transitionOrder('paid')` — в
  **одной транзакции**. Сбой перехода откатывает claim (иначе оплаченный заказ
  застрянет без recovery).
- ❌ Нарушение: claim и переход разными транзакциями/`await`; уведомление/выпуск
  карты внутри транзакции (должно быть после commit).

## B4 · issue-card — at-most-once

- Выпуск карты стартует с атомарного claim `paid → in_fulfillment`
  (`transitionOrderDetailed`) **до** любых операций PaySpace.
- ❌ Нарушение: вызов `createCard`/`topupCard` до claim; отсутствие проверки
  `transitioned`; повторный выпуск при recovery без защиты.
- PaySpace idempotency-ключ — **короткий** `paySpaceRequestId` (`t_<16hex>`).
  ❌ длинный `request_id` → silent `topup_failed` и новая карта на каждый заказ.

## B5 · Webhook всегда `200 OK`

- Все webhook-эндпоинты возвращают `200` даже при невалидном теле (ошибку кладут в
  тело ответа), иначе Telegram/L&P ретраят и забивают очередь.
- **Единственное исключение**: `/api/bot` отдаёт `401` при неверном
  `X-Telegram-Bot-Api-Secret-Token`.
- ❌ Нарушение: `4xx/5xx` из `/api/payments/loveandpay` или `/api/bot` (кроме
  secret-token), `throw` наружу из webhook-хендлера без перехвата в `200`.

## B6 · Подписи и внутренние токены

- L&P webhook — проверка подписи до обработки. Реальный контракт события —
  `invoice.paid`, id в `data.id` (тестовая панель кабинета L&P шлёт фейковый формат —
  не подстраивать код под неё).
- `/api/payments/create` — защита `X-Internal-Token`; `/api/bot` — secret-token.
  Сравнение секретов — **timing-safe** (см. ось C).
- ❌ Нарушение: обработка webhook до валидации подписи; отсутствие проверки
  внутреннего токена на внутреннем эндпоинте; `===` вместо timing-safe для секрета.

## B7 · Реферальные начисления

- `accrueReferralForPayment` вызывается в `processInvoicePaid` сразу после claim.
  Идемпотентность — `UNIQUE(payment_id, beneficiary, level)`, ledger append-only.
- Инвариант: **сумма начислений заказа ≤ его комиссия**. Уровень только 1
  (`REFERRAL_MAX_LEVEL=1`), новые начисления уровней 2–3 не создаются.
- ❌ Нарушение: начисление вне claim-победителя; `UPDATE`/`DELETE` ledger'а;
  начисление без учёта UNIQUE; сумма начислений превышает комиссию; новые строки
  уровней >1.
- ⚠️ Реф-захват: `referred_by_set_at` в raw-`INSERT` = SQL `now()`, **не** JS
  `new Date()` (Date-объект в bind-параметре роняет слой кэша запросов). ❌ `new
  Date()` в bind-параметре reферрального INSERT.

## B8 · Границы заказа (защита AI-расходов)

- `propose_order`: сумма **$1–500**, **≤10 заказов/сутки** на пользователя. Курс
  USD→RUB фиксируется при `propose_order`, снимок цены — в заказ.
- Разбивка цены: `курс × USD + COMMISSION_PERCENT` + разовый
  `CARD_ISSUE_FEE_USD_CENTS` только когда у клиента **нет** активной карты
  (`findActiveByUserId`); снимок в `orders.card_issue_fee_kopecks`.
- Гейт оплаты: веб-пользователь без `telegram_id` не получает ссылку —
  `TelegramLinkRequiredError`. `payments/create` при повторном confirm заказа в
  `pending_payment` идемпотентно возвращает существующий инвойс (`repeat_confirm`).
- ❌ Нарушение: снятие/ослабление границ суммы или лимита/сутки; fee при наличии
  активной карты; выдача платёжной ссылки веб-юзеру без `telegram_id`; повторный
  confirm создаёт новый инвойс вместо возврата существующего.
