# PLAN — Фаза 2: виртуальные карты (app.pay.space)

> План разработки фазы выпуска виртуальных USD-карт. Контекст архитектуры — [`docs/architecture.md`](docs/architecture.md), правила — [`CLAUDE.md`](CLAUDE.md).
> Карты выпускает **app.pay.space** (`https://app.pay.space/api/v1`). Это НЕ Love&Pay: L&P — только приём RUB от клиента (работает e2e). Деньги клиента (RUB, копейки) и баланс карты (USD-центы) — разные сущности.

## Целевой флоу (со слов заказчика)

```
1. Клиент платит Оплатишке (RUB)            ──→ [РАБОТАЕТ: L&P webhook → order=paid]
2. Оператор подсказывает, как завести        ──→ [ручное, вне системы]
   кабинет в ИИ-сервисе
3. Из PaySpace выдаём реквизиты карты        ──→ createCard / topup на нужную USD-сумму,
   (PAN/срок/CVC) с нужной суммой                реквизиты клиенту в Telegram
4. Клиент оплачивает картой сервис           ──→ карта уходит в ЗАМОРОЗКУ (freeze)
5. Клиент возвращается (новый заказ)         ──→ карта РАЗМОРАЖИВАЕТСЯ + ПОПОЛНЯЕТСЯ
```

Шаги 4–5 (freeze/unfreeze + topup при возврате) — **не реализованы**, заблокированы открытыми решениями (см. ниже).

## Что уже в коде (ветка `dev`)

- **Таблица `cards`** (`packages/db/src/schema.ts`): `provider_card_id` UNIQUE, `pan_masked` (полный PAN в БД не хранится), `balance_usd_cents` integer, enum `card_status = active | idle | recycled` (**`frozen` нет**), `last_used_at`/`recycled_at`, RLS включён.
- **Репозиторий** (`packages/db/src/repositories/cards.ts`): `createCard`, `findActiveByUserId` (LIFO), `findRecyclableCard`, `markIdle`, `markRecycled`, `markActive` (переписывает владельца), `updateBalance`, `recycleAgedCards`.
- **PaySpace-клиент** (`apps/web/lib/pay-space/client.ts`): `createCard` / `topupCard` / `getCard`. Timeout 60s, retry ×2 на 5xx/сеть, Zod-парс каждого ответа (`PaySpaceContractError` при дрейфе). **`freezeCard`/`unfreezeCard` отсутствуют.** Формат auth-заголовка — TODO (Bearer — предположение).
- **Job `issue-card`** (`apps/web/lib/jobs/issue-card.ts`), вызывается из L&P-webhook: заказ должен быть `paid` → topup активной карты юзера → иначе переиспользование recyclable → иначе выпуск новой → реквизиты клиенту в Telegram → `setOrderCardId` → `paid → in_fulfillment → completed` (actor `system`). На фейл — `paid → failed` + Sentry critical.
- **Guard:** без `PAYSPACE_API_KEY` + `PAYSPACE_ACCOUNT_ID` → лог `skipped_no_paypace`, заказ остаётся в `paid` (ручной fulfillment). Поэтому сейчас выпуск выключен в prod/preview.
- **Cron `recycle-cards`** (03:30 UTC ежедневно): `active → idle` после 90 дней простоя, `idle → recycled` после 180. Recycled-карты переиспользуются для новых клиентов.
- **Zod-типы PaySpace** (`packages/types/src/paypace.ts`) — **гипотеза контракта, НЕ подтверждена живым вызовом**.

## Гипотеза контракта PaySpace (подтвердить до доверия — D2)

| Метод | HTTP | Путь (предполож.) | Запрос | Ответ |
|---|---|---|---|---|
| createCard | POST | `/cards` | `accountId`, `externalUserId`, `initialBalanceUsdCents` | `cardId`, `pan`, `panMasked`, `expMonth`, `expYear`, `cvc`, `balanceUsdCents` |
| topupCard | POST | `/cards/{id}/topup` | `amountUsdCents` | `cardId`, `balanceUsdCents` |
| getCard | GET | `/cards/{id}` | — | `cardId`, `panMasked`, `status` (`active`/`blocked`/`expired`), `balanceUsdCents` |
| freezeCard / unfreezeCard | ? | **не определены — существуют ли вообще?** | ? | ? |

## Открытые решения (блокируют код — не выдумывать, ждать владельца)

- **D1 — что триггерит заморозку?** Мы не видим оплату клиента на стороне ИИ-сервиса. Варианты: **(a)** webhook PaySpace о трате по карте → нужен endpoint + подпись + идемпотентность (как у L&P); **(b)** freeze сразу после выдачи реквизитов, unfreeze при новом заказе — самый простой, без webhook'ов; **(c)** оператор вручную. Вопрос к заказчику.
- **D2 — реальный контракт PaySpace.** Владелец даёт доки/доступ к кабинету. Подтвердить: пути и тела всех эндпоинтов, формат сумм (центы или доллары?), формат auth-заголовка, набор статусов карты, существование freeze/unfreeze. **Урок Love&Pay: тестовая панель кабинета врала — контракт снимать только живым вызовом.**
- **D3 — как `frozen` сосуществует с `idle`/`recycled`?** Recycle — по времени, freeze — по событию. Можно ли recycle'ить frozen-карту? Замораживать idle? Какой статус PaySpace маппится на наш `frozen`? Что с `balance_usd_cents` при заморозке?
- **D4 — actor переходов.** `issue-card` делает `paid → in_fulfillment → completed` автоматически как `system`, без оператора и proof. Подтвердить у владельца, что для карточных заказов это норма (для ручного fulfillment остаётся оператор).

## План работ

### Шаг 0 — разблокировка (владелец, вне кода)

- [ ] Получить доступ/доки app.pay.space (кабинет + API-ключи sandbox или боевые).
- [ ] Ответ заказчика по D1 (триггер заморозки) и D4 (автоматический `system`-флоу — ок?).
- [ ] Узнать у PaySpace: есть ли freeze/unfreeze и webhook о тратах (определяет D1 и D3).

### Шаг A — подтверждение контракта (после доступа)

- [ ] Живые вызовы `createCard` / `topupCard` / `getCard` на минимальной сумме; зафиксировать реальные пути/тела/ответы/auth.
- [ ] Привести Zod-схемы `packages/types/src/paypace.ts` и клиент к реальному контракту; убрать TODO по auth.
- [ ] Прогнать Vitest на новые схемы (по образцу `loveandpay`-тестов).

### Шаг B — включение выпуска end-to-end

- [ ] Добавить `PAYSPACE_API_KEY` + `PAYSPACE_ACCOUNT_ID` в Vercel env (Preview сначала; Sensitive) + redeploy.
- [ ] Smoke на dev-боте: реальный заказ малой суммы → оплата L&P → `issue-card` → реквизиты в Telegram → заказ `completed`. Проверить ветки: новая карта / topup существующей / переиспользование recycled.
- [ ] Проверить безопасность: `pan`/`cvc` отсутствуют в логах/Sentry (только `pan_masked`); реквизиты ушли единственным сообщением в Telegram.
- [ ] Prod-rollout: env в Production + redeploy + контрольный заказ.

### Шаг C — заморозка/разморозка (после D1/D3)

- [ ] Additive-миграция Drizzle: значение `frozen` в enum `card_status` (+ логика сосуществования с recycle по решению D3).
- [ ] `freezeCard`/`unfreezeCard` в клиенте и типах (или реализация выбранного варианта D1, если методов у PaySpace нет).
- [ ] В `issue-card`: для вернувшегося клиента — unfreeze + topup вместо выпуска новой.
- [ ] Если D1 = (a): endpoint webhook'а PaySpace с подписью и идемпотентностью по образцу L&P.
- [ ] Обновить `recycle-cards` под frozen-карты (по D3).

### Шаг D — операционная обвязка

- [ ] Алёрты: фейл выпуска (уже Sentry critical) + расхождение баланса карты с ожиданием.
- [ ] Сверка `renewal-reminder` с флоу карт (напоминание за 4–5 дней до продления — клиент возвращается → шаг 5 флоу).
- [ ] Обновить `docs/architecture.md` §6 и `docs/CHANGELOG.md` по факту включения.

## Безопасность (инварианты фазы)

- Полные `pan`/`cvc` **никогда** не пишутся в БД/логи/Sentry — только `pan_masked`. Действует и для новых методов (freeze/unfreeze/webhook).
- Реквизиты клиенту — единственным путём: сообщение в Telegram (`sendCardCredentialsToUser`).
- Все ответы PaySpace — через Zod (`safeParse`), дрейф контракта → `PaySpaceContractError`, не silent-парс.

## Env фазы

| Переменная | Назначение | Состояние |
|---|---|---|
| `PAYSPACE_API_KEY` | ключ API (Sensitive) | не задан — выпуск выключен |
| `PAYSPACE_ACCOUNT_ID` | id мерчант-аккаунта | не задан — выпуск выключен |
| `PAYSPACE_BASE_URL` | база API | default `https://app.pay.space/api/v1` |
| `COMMISSION_PERCENT` | комиссия заказа (RUB) | default `10` |
