> **АРХИВ (2026-06-29).** Это исторический план Фазы 2 (виртуальные карты PaySpace),
> вынесенный из корневого `plan.md` при переходе к плану реферальной программы.
> Содержимое — снимок на момент архивации, как есть. Большая часть фазы реализована
> и работает на проде (выпуск карт live с 2026-06); оставшиеся операционные пункты
> (префандинг VCC, контрольный live-`createCard`, prod-smoke, VCC-webhook) продолжают
> отслеживаться здесь, пока не закрыты. Актуальный рабочий план — корневой `plan.md`.

---

# PLAN — Фаза 2: виртуальные карты (app.pay.space)

> План внедрения фазы выпуска виртуальных USD-карт. Контекст архитектуры — [`docs/architecture.md`](docs/architecture.md), правила — [`CLAUDE.md`](CLAUDE.md).
> Карты выпускает **app.pay.space** (`https://app.pay.space/api/v1`). Это НЕ Love&Pay: L&P — только приём RUB от клиента (работает e2e). Деньги клиента (RUB, копейки) и баланс карты (USD) — разные сущности.
>
> **2026-06-16: контракт VCC подтверждён официальной OpenAPI-докой (`api-1.json`).** Блокер D2 снят докой; гипотеза в коде (`packages/types/src/paypace.ts` + клиент) оказалась неверной почти во всём — типы и клиент переписываем. Перед prod-доверием всё равно нужен один живой вызов (урок L&P: тестовая панель врала).

## Целевой флоу

```
1. Клиент платит Оплатишке (RUB) своей картой РФ  ──→ [РАБОТАЕТ: L&P webhook → order=paid]
   (RUB = цена сервиса USD × курс + 10% комиссия)
2. Оператор подсказывает, как завести кабинет     ──→ [ручное, вне системы]
   в ИИ-сервисе
3. Выпуск/пополнение виртуальной USD-карты         ──→ create на цену сервиса (USD), либо topup
   ровно на нужную сумму                               активной карты этого клиента
4. Выдаём клиенту реквизиты карты (PAN/срок/CVC)   ──→ ЕДИНСТВЕННЫМ путём: сообщение в Telegram
5. Клиент сам оплачивает картой иностранный сервис ──→ карта остаётся с ~0 баланса
6. Возврат (продление) того же клиента             ──→ topup той же карты (не выпускаем новую)
```

**Важно — «заморозки» нет.** В API PaySpace freeze/unfreeze отсутствуют (см. контракт ниже). Прежний план «freeze после оплаты / unfreeze при возврате» нереализуем и заменён моделью: выпускаем ровно на нужную сумму → рекуррент/повторное списание проваливается само (баланс ~0) → при возврате `topup` → по долгому простою `release` (закрыть). Опционально — авто-`withdraw` остатка после подтверждённой траты (если включим webhook карты).

## Что уже в коде (ветка `dev`)

- **Таблица `cards`** (`packages/db/src/schema.ts`): `provider_card_id` UNIQUE, `pan_masked` (полный PAN в БД не хранится), `balance_usd_cents` integer, enum `card_status = active | idle | recycled`, `last_used_at`/`recycled_at`, RLS включён. **Менять enum не нужно — `frozen` не требуется** (см. жизненный цикл).
- **Репозиторий** (`packages/db/src/repositories/cards.ts`): `createCard`, `findActiveByUserId` (LIFO), `findRecyclableCard`, `markIdle`, `markRecycled`, `markActive` (переписывает владельца), `updateBalance`, `recycleAgedCards`.
- **PaySpace-клиент** (`apps/web/lib/pay-space/client.ts`): `createCard` / `topupCard` / `getCard` — **написаны по НЕВЕРНОЙ гипотезе** (пути `/cards`, плоский ответ, центы-integer). Timeout 60s, retry ×2, Zod-парс, `PaySpaceContractError` при дрейфе — каркас годный, переписать тело под реальный контракт. `freezeCard`/`unfreezeCard` отсутствуют (и не нужны).
- **Job `issue-card`** (`apps/web/lib/jobs/issue-card.ts`): atomic claim `paid → in_fulfillment` (`transitionOrderDetailed`, at-most-once) → topup активной карты → иначе recyclable → иначе createCard → реквизиты в Telegram → `setOrderCardId` → `in_fulfillment → completed` (actor `system`). На фейл — `failed` + Sentry critical. **Логика корректна; правок по контракту минимум** (async topup, маска PAN считается локально).
- **Guard:** без `PAYSPACE_API_KEY` → лог `skipped_no_paypace`, заказ остаётся в `paid` (ручной fulfillment). Выпуск выключен в prod/preview.
- **Cron `recycle-cards`** (03:30 UTC): `active → idle` (90 дней простоя), `idle → recycled` (180). **Нужно добавить реальный `release` в провайдере при переходе в `recycled`** (сейчас меняется только наш статус).
- **Zod-типы PaySpace** (`packages/types/src/paypace.ts`) — **гипотеза, переписать под контракт ниже.**

## Подтверждённый контракт VCC (из `api-1.json`)

**База:** `https://app.pay.space/api/v1`. **Auth:** `Authorization: Bearer <API_KEY>` (подтверждено). Опционально: IP-whitelist и HMAC-SHA256 подпись запроса (заголовки `X-Timestamp`/`X-Nonce`/`X-Signature`) — только если в кабинете задан `request_secret`.
**Обёртка всех ответов:** `{ "success": true, "data": {…} }` либо `{ "success": false, "error": { "code", "message" } }`.
**Деньги:** строки-доллары (`"10.00"`), НЕ центы-integer. Конвертируем центы↔строку на границе клиента (внутренний инвариант «деньги — integer» сохраняем).

| Операция | HTTP | Путь | Запрос | Ответ (`data`) |
|---|---|---|---|---|
| Выпуск карты | POST | `/vcc/card/create/` | `amount` (мин $1), `product_code?`=`SG_SUB`, `expdate?` YYYY-MM-DD (30д–4г, дефолт +1г), `network?`=`trc20`, `callback_url?` | `card{ card_id, card_no (полный PAN 16 цифр), cvv, exp_date YYYY-MM-DD, balance, currency, callback_url }, network` |
| Пополнить карту | POST | `/vcc/card/topup/` | `card_id`, `amt`, `request_id?` (идемпотентность) | `request_id, status: pending\|completed\|failed` — **асинхронно** |
| Статус пополнения | GET | `/vcc/card/topup/check/` | `?card_id=&request_id=` | `total_amt, recharge_amt, op_time` |
| Слить с карты | POST | `/vcc/card/withdraw/` | `card_id`, `amt`, `request_id?` | `request_id, status` (+ `/vcc/card/withdraw/check/`) |
| Закрыть карту | POST | `/vcc/card/release/` | `card_id`, `request_id?` | `cardId, releaseBal` — **НЕОБРАТИМО**, остаток назад на VCC-баланс |
| Инфо о карте | GET | `/vcc/card/info/` | `?card_id=` | `cardNo, cvv, expDate MM/YY, status "0".."9", cardBal, usedAmt, totalAmt, …` |
| Список карт | GET | `/vcc/cards/` | `?status=&card_id=&limit=&offset=` | `cards[], total, limit, offset` |
| Транзакции по картам | GET | `/vcc/transactions/` | `?type=A\|R&card_id=&date_from=&date_to=` | покупки (A) / возвраты (R): `txn_id, status, txn_amount, merchant_name, mcc, decline_reason, …` |
| Баланс VCC-аккаунта | GET | `/vcc/user/balance/` | — | `balance, pending, currency` |
| Пополнить VCC-баланс | POST | `/vcc/balance/topup/` | `amount, network` | `id, amount_to_credit, fee_percent (~3%), status` — **T+1** |
| Проверка связи | GET | `/ping/` | — | бесплатно, для проверки ключа |

**Статусы карты (числовые строки):** `0` Deactivated · `1` Activated · `2` Frozen · `3` Expired · `4` Locked · `9` Inactivated. `Frozen` ставит риск-движок провайдера — мы им НЕ управляем (нет freeze-эндпоинта), только читаем.

**Ключевые отличия от гипотезы (что переписать):**
- Пути: `/vcc/card/create|topup|info|release|withdraw` (id в теле/в query, не в пути `/cards/{id}`).
- Обёртка `{success,data}` — распаковывать; суммы — строки-доллары, не центы.
- Поля: `card_no`/`cvv`/`exp_date`/`balance`. **`panMasked` провайдер не даёт — маску считаем сами из `card_no`.**
- `create` сразу отдаёт полный `card_no`+`cvv` → отдельный `card/info` для выдачи не нужен.
- `topup` асинхронный (`request_id`+`status`) → при `pending` поллить `topup/check/`.
- В `create` нет `externalUserId`/`accountId` (accountId неявно в API-ключе) → привязку user↔card держим только в нашей таблице `cards`.
- `request_id` — идемпотентный ключ для topup/withdraw/release (генерим из `orderId`).
- Учесть **issue fee $4** при выпуске новой карты.

## Жизненный цикл карты (наш enum ↔ провайдер)

`frozen` в enum **не нужен**. Маппинг:
- `active` — карта с балансом, привязана к одному клиенту, переиспользуется его повторными заказами через `topup` (экономит $4 за каждый невыпуск). Одна активная карта на клиента (если оплачивает несколько сервисов — пополнения идут на одну карту; решить, ок ли — см. D5).
- `idle` (90 дней простоя, cron) — можно `withdraw` остаток; держим для reuse.
- `recycled` (180 дней, cron) — вызвать реальный **`release`** в провайдере (остаток вернётся на VCC-баланс), карта закрыта.

## Тестирование без реальных денег / песочница

- **Отдельной sandbox для VCC-карт в доке НЕТ.** Флаг `is_test` есть только у крипто-инвойсов (мы их не используем). Выпуск карты = **$4 fee + сумма** реальными с VCC-баланса; `topup` двигает реальные средства. `release` возвращает остаток карты (не fee).
- **Уровень 1 (бесплатно):** весь наш пайплайн (order → L&P webhook → state-machine → `issue-card` claim → Telegram) — на **мок-клиенте PaySpace** (`fetchImpl` инъектируется, Vitest, как в `loveandpay`-тестах). Покрывает ~90% логики.
- **Уровень 2 (бесплатно):** `GET /ping/` — проверить реальный ключ/связь.
- **Уровень 3 (реальные деньги, минимум):** один контрольный выпуск карты на **$1** (минимум) + $4 fee ≈ **$5**. Снимаем контракт живым вызовом, затем `release` для возврата остатка.
- **Действие за владельцем:** спросить менеджера PaySpace, есть ли тестовый мерчант/sandbox (в доке не описан). Если нет — заложить ~$5 и предварительный фандинг VCC-баланса (T+1).

## Открытые решения

- **D2 — контракт PaySpace.** ЗАКРЫТ докой `api-1.json`. Остаётся подтвердить живым вызовом: точную обёртку, синхронность `topup`, реально ли `create` отдаёт `card_no` сразу, наличие комиссии у `topup` карты.
- **D1 — триггер «закрытия» оплаты.** Заморозки нет. По умолчанию: ничего не делаем (карта на ровно нужную сумму, рекуррент провалится сам). Опционально (a) webhook карты о трате → авто-`withdraw` остатка + аналитика. Вопрос владельцу: нужен ли авто-`withdraw` или достаточно «ровно на сумму».
- **D3 — `frozen`.** Снят: новый статус не нужен, recycle делаем через `release` (см. жизненный цикл).
- **D4 — actor переходов.** `issue-card` делает `paid → in_fulfillment → completed` автоматически как `system`, без оператора/proof. Подтвердить у владельца, что для карточных заказов это норма.
- **D5 — одна карта на клиента vs карта-на-заказ.** Сейчас все заказы клиента пополняют одну активную карту. Решить, не мешает ли это разнести разные сервисы/суммы.
- **D6 — подпись VCC-вебхука.** Если делаем webhook (D1-a): схема подписи на `/api/docs/vcc-webhooks/` рендерится JS, достать не удалось. Payload = формат элемента `/vcc/transactions/` (тип A/R). Подтвердить схему подписи у владельца/живым тестом (вероятно тот же HMAC-SHA256, что у запросов).

## План работ

### Шаг 0 — разблокировка (владелец, вне кода)

- [ ] Получить `PAYSPACE_API_KEY` (боевой; sandbox — если есть).
- [ ] Профандить VCC-баланс на сумму контрольных тестов + буфер (T+1 — заранее).
- [ ] Ответы по D1 (нужен ли авто-`withdraw`), D4 (авто-`system`-флоу ок?), D5 (одна карта на клиента?), включать ли `request_secret` (подпись запросов).

### Шаг A — переписать контракт под доку (код, разблокировано) — ✅ СДЕЛАНО (ветка `payspace`)

- [x] Переписан `packages/types/src/paypace.ts`: обёртка `{success,data}`, реальные поля, суммы-строки, схемы create/topup/topup-check/withdraw-check/release/info/user-balance.
- [x] Переписан `apps/web/lib/pay-space/client.ts`: реальные пути, распаковка `data`+проверка `success`, конвертация центы↔строки (`format.ts`), `request_id`-идемпотентность, async-topup с поллингом `topup/check/`, методы `withdrawCard`/`releaseCard`/`getCardInfo`/`getVccBalance`. HMAC-подпись запроса (`sign.ts`, если задан `requestSecret`). Убраны `freezeCard`/`unfreezeCard`.
- [x] Vitest: `format.test.ts`, `sign.test.ts`, `client.test.ts` (24 теста) + обновлён `issue-card.test.ts`. Зелёные.

### Шаг B — `issue-card` + recycle под реальный контракт

- [x] `issue-card`: `pan_masked` считается локально из `card_no` (в клиенте); async `topup` → поллинг `topup/check/`, заказ завершается только при `status=completed` (иначе → `failed`); `request_id` из `orderId`.
- [x] `PAYSPACE_ACCOUNT_ID` убран из guard (`isPaySpaceConfigured` = только `PAYSPACE_API_KEY`); env оставлен как unused до подтверждения live-вызовом.
- [x] `recycle-cards`: `idleAgedActiveCards` (active→idle) + `findCardsToRecycle` → пер-картный `releaseCard` → `markRecycled` (at-least-once, ошибку добивает следующий запуск); без ключа PaySpace шаг release пропускается. Cross-client reuse убран из `issue-card` (release необратим, PAN не делим между клиентами). Тесты `recycle-cards.test.ts`.

### Шаг C — живой контроль контракта (минимальные деньги)

- [x] Живой read-only вызов `GET /vcc/user/balance/` боевым ключом (2026-06-16): **auth (Bearer) + HMAC-подпись запроса + обёртка `{success,data}` + Zod подтверждены** (сервер принял подпись). Каноническая форма query/подписи — верна. **VCC-баланс = $0.00** → выпуск/topup сейчас упадут на нехватке средств; перед Шагом C-2 и D нужно пополнить VCC-аккаунт (T+1).
- [ ] **Префандинг:** пополнить VCC-баланс (владелец, T+1) на сумму контрольного теста + буфер.
- [ ] Один `createCard` на $1 → зафиксировать реальные тела/ответы/коды; проверить async-topup и `topup/check/`; затем `releaseCard` (вернуть остаток). Сверить Zod, поправить дрейф.

### Шаг D — включение end-to-end

- [ ] `PAYSPACE_API_KEY` в Vercel env (Preview первым; Sensitive) + redeploy.
- [ ] Smoke на dev-боте: заказ малой суммы → оплата L&P → `issue-card` → реквизиты в Telegram → `completed`. Ветки: новая карта / topup существующей / переиспользование recycled.
- [ ] Безопасность: `pan`/`cvc` отсутствуют в логах/Sentry (только `pan_masked`); реквизиты ушли единственным сообщением в Telegram.
- [ ] Prod-rollout: env в Production + redeploy + контрольный заказ.

### Шаг E — операционная обвязка

- [x] Алёрт на **низкий VCC-баланс**: в cron `recycle-cards` через `getVccBalance` < `PAYSPACE_MIN_VCC_BALANCE_USD_CENTS` (дефолт $50) → Sentry warning. (Можно вынести в отдельный/более частый cron, если суточной частоты мало.)
- [ ] Алёрт: фейл выпуска (уже Sentry critical) + расхождение баланса карты с ожиданием.
- [ ] (Опц., если D1-a) endpoint webhook'а карты: подпись (D6) + идемпотентность по образцу L&P + авто-`withdraw` остатка.
- [ ] Сверка `renewal-reminder` с флоу карт (напоминание за 4–5 дней до продления → клиент возвращается → шаг 6).
- [ ] Обновить `docs/architecture.md` §6 и `docs/CHANGELOG.md` по факту включения.

## Операционные ограничения (заложить в дизайн)

- **Префандинг VCC-баланса:** пополнение субаккаунта — **T+1** + ~3% fee. Фандить заранее, держать буфер.
- **Стоимость:** новая карта = $4 fee + сумма; reuse активной/recyclable экономит $4 — логика reuse оправдана.
- **Async topup:** после `topup` поллить `topup/check/` до `completed`.
- **Цепочка фондов:** крипто-депозит → USDT-баланс PaySpace → (T+1) → VCC-субаккаунт → выпуск/topup карт. Отдельный от L&P (RUB) контур.

## Безопасность (инварианты фазы)

- Полные `pan`/`cvc` **никогда** не пишутся в БД/логи/Sentry — только `pan_masked` (считаем из `card_no`). Действует и для webhook/новых методов.
- Реквизиты клиенту — единственным путём: сообщение в Telegram (`sendCardCredentialsToUser`).
- Все ответы PaySpace — через Zod (`safeParse`), дрейф контракта → `PaySpaceContractError`, не silent-парс.

## Env фазы

| Переменная | Назначение | Состояние |
|---|---|---|
| `PAYSPACE_API_KEY` | ключ API, `Bearer` (Sensitive) | задан локально (.env), подтверждён live; в Vercel — Шаг D |
| `PAYSPACE_REQUEST_SECRET` | секрет HMAC-подписи запросов | задан локально, подпись работает (live) |
| `PAYSPACE_WEBHOOK_SECRET` | проверка подписи входящих VCC-вебхуков | задан, но вебхук-endpoint не реализован (Шаг E / D6) |
| `PAYSPACE_MIN_VCC_BALANCE_USD_CENTS` | порог алёрта баланса VCC | default `5000` ($50) |
| `PAYSPACE_ACCOUNT_ID` | (legacy) id мерчант-аккаунта | **в коде НЕ используется** — accountId неявен в ключе |
| `PAYSPACE_BASE_URL` | база API | default `https://app.pay.space/api/v1` |
| `COMMISSION_PERCENT` | комиссия заказа (RUB) | default `10` |
