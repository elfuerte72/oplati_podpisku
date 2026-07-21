# Remnawave API — интеграция VPN в Оплатишку (справочник для агента-разработчика)

Назначение: бэкенд Оплатишки (Next.js, `oplati_podpicky`) по кнопке **🛡 VPN** в Telegram-боте
создаёт/находит пользователя в панели Remnawave, отдаёт ему **ссылку-подписку** и пишет её в БД.
На оплате (Love&Pay) — продлевает; на истечении — отключает.

---

## ⛔ Инвариант безопасности (не нарушать)

- **API-токен Remnawave живёт ТОЛЬКО на бэкенде** (env / секрет-менеджер). **Никогда** в браузере, во фронте, в Telegram-WebApp, в логах, в git. Зеркалит паттерн PaySpace/Love&Pay: токен — серверный.
- Панель `panel.mxpkn8ns.ru` наружу за логином; **все вызовы API — только server-side** (route handler / server action / бот-бэкенд), не с клиента.
- Для Оплатишки завести **отдельный API-токен** (не мастер-токен владельца) — чтобы можно было отозвать независимо. Как выпустить — см. в конце.

---

## Базовое

- **Base URL:** `https://panel.mxpkn8ns.ru/api`
- **Auth:** заголовок `Authorization: Bearer <TOKEN>`, `Content-Type: application/json`
- **Домен подписок (то, что уходит клиенту):** `https://sub.mxpkn8ns.ru/api/sub/<shortUuid>`
- **Squad по умолчанию** (в него кладём юзера, чтобы он получил ОБА подключения — Lithuania + «При белых списках»):
  `Default-Squad` = `e819a231-6e10-46c6-8411-7001dd67e9e1`
- Формат ответа панели: `{ "response": { ...данные... } }` — полезное всегда в `response`.
- Полный контракт/OpenAPI: **https://docs.rw** (там же схемы DTO). Ниже — проверенные на живой панели вызовы.

---

## Ключевой момент про «подписку»

Одна ссылка-подписка на юзера отдаёт **список подключений** (сейчас два: `🇱🇹 Lithuania` и `🇷🇺 При белых списках`).
Клиент (Happ / v2rayTun) добавляет ЭТУ ссылку — и сам видит оба сервера, переключается между ними.
Бэкенду **не нужно** генерировать конфиги — только получить `subscriptionUrl` и отдать его.

---

## Эндпоинты, которые нужны

### 1. Найти юзера по Telegram ID (проверить, есть ли уже)
```
GET /api/users/by-telegram-id/{telegramId}
```
Вернёт массив/юзера, если существует. Если нет — создаём (шаг 2). Идемпотентность: **не плодить дубли** на один telegramId.
(Есть и `GET /api/users/by-username/{username}`, `GET /api/users/{uuid}`.)

### 2. Создать юзера
```
POST /api/users
```
Тело (минимум):
```json
{
  "username": "tg_123456789",
  "telegramId": 123456789,
  "expireAt": "2026-08-21T00:00:00.000Z",
  "trafficLimitBytes": 214748364800,
  "trafficLimitStrategy": "MONTH",
  "activeInternalSquads": ["e819a231-6e10-46c6-8411-7001dd67e9e1"]
}
```
- `username` — уникальный, латиница/цифры/`_` (например `tg_<telegramId>`).
- `telegramId` — число (связывает юзера панели с ТГ-юзером; по нему потом ищем).
- `expireAt` — ISO-8601 UTC, дата окончания доступа.
- `trafficLimitBytes` — лимит трафика в байтах (`0` = безлимит). Пример: `200 ГБ = 214748364800`.
- `trafficLimitStrategy` — `NO_RESET` | `DAY` | `WEEK` | `MONTH` (когда обнулять счётчик).
- `activeInternalSquads` — массив uuid сквадов (обязательно Default-Squad, иначе подписка пустая).

**Ответ (`response`) содержит всё нужное:**
```json
{
  "uuid": "6a2a8882-...",                // ← ГЛАВНЫЙ id для будущих update/disable (храни в БД)
  "username": "tg_123456789",
  "shortUuid": "V09yNf4WMN3EmLRn",
  "subscriptionUrl": "https://sub.mxpkn8ns.ru/api/sub/V09yNf4WMN3EmLRn",  // ← отдать юзеру + в БД
  "status": "ACTIVE",
  "expireAt": "2026-08-21T00:00:00.000Z",
  "telegramId": 123456789,
  "trafficLimitBytes": 214748364800,
  "vlessUuid": "480b4e7a-..."            // внутренний id протокола, бэкенду не нужен
}
```
> Важно: для дальнейших операций храни **`uuid`** (это `response.uuid`), а НЕ `vlessUuid`.

### 3. Продлить / изменить юзера (оплата, смена плана)
```
PATCH /api/users
```
Тело:
```json
{ "uuid": "6a2a8882-...", "expireAt": "2026-09-21T00:00:00.000Z", "trafficLimitBytes": 322122547200 }
```
Меняет только переданные поля. Так продлеваем по вебхуку оплаты.

### 4. Отключить / включить юзера
```
PATCH /api/users
{ "uuid": "6a2a8882-...", "status": "DISABLED" }
```
`status`: `ACTIVE` | `DISABLED` | `LIMITED` | `EXPIRED`. Отключение сразу рубит доступ (панель снимает юзера с нод).
Панель и сама переведёт в `EXPIRED`/`LIMITED` по `expireAt`/лимиту — можно полагаться на это и просто ставить срок.
> Проверь в OpenAPI, нет ли отдельных `.../actions/enable|disable` — если есть, используй их (семантика та же).

### 5. Показать статус/трафик юзера (для «мой VPN» в боте)
```
GET /api/users/{uuid}   (или by-telegram-id)
```
В ответе: `status`, `expireAt`, `userTraffic.usedTrafficBytes`, `trafficLimitBytes`, `subscriptionUrl`.

---

## Поток кнопки 🛡 VPN (MVP)

1. Юзер жмёт «VPN».
2. Бэкенд: `GET /api/users/by-telegram-id/{tgId}`.
   - Есть → берём `subscriptionUrl` из ответа.
   - Нет → `POST /api/users` (username `tg_<tgId>`, telegramId, expireAt = сейчас + пробный срок или срок оплаченного плана, Default-Squad).
3. Бэкенд отправляет юзеру **`subscriptionUrl`** + короткую инструкцию (поставить Happ → «добавить подписку по URL» → вставить).
4. Бэкенд делает **upsert в БД** (см. схему).
5. (Позже) Оплата Love&Pay → вебхук → `PATCH /api/users` продлить `expireAt` → обновить БД.

---

## Схема БД (предложение — таблица `vpn_subscriptions`)

| поле                 | тип         | назначение                                  |
|----------------------|-------------|---------------------------------------------|
| `user_id`            | FK users    | владелец (юзер Оплатишки)                   |
| `telegram_id`        | bigint      | ТГ-id (ключ поиска в Remnawave)             |
| `remnawave_uuid`     | uuid        | `response.uuid` — для update/disable        |
| `subscription_url`   | text        | что отдали клиенту                          |
| `plan`               | text        | тариф/срок                                  |
| `status`             | text        | зеркало статуса панели                      |
| `expire_at`          | timestamptz | срок                                        |
| `created_at`/`updated_at` | timestamptz | аудит                                  |

Уникальность по `telegram_id` (или `remnawave_uuid`) — чтобы не плодить дубли.

---

## Как выпустить отдельный токен для Оплатишки

В панели: **Настройки Remnawave → API-токены (API Keys)** → создать новый токен «oplatishka-backend» → положить его в env бэкенда Оплатишки (`REMNAWAVE_API_TOKEN`), НЕ в мастер-токен владельца. Отзыв — там же.
(Мастер-токен владельца сейчас в `secrets/server-baseline/remnawave/api-token.env` этого репо — его агенту НЕ давать.)

---

## Грабли / примечания

- `response.uuid` (для операций) ≠ `response.vlessUuid` (id протокола). Храни `uuid`.
- Подписка per-user и стабильна (по `shortUuid`) — можно писать в БД один раз.
- Один `telegramId` = один юзер панели: перед созданием всегда проверяй `by-telegram-id`.
- Всё server-side. Токен — только в env бэкенда.
- Инфраструктура (ноды, whitelist, цепочка) уже готова и живёт в панели — бэкенду достаточно CRUD по юзерам.

---

## Подтверждено живыми вызовами (2026-07-21, реализация в коде)

Контракт снят с живой панели при внедрении кнопки «VPN» в боте:

- `POST /api/users` → **201**, `response.uuid/shortUuid/subscriptionUrl` — как выше.
- `GET /api/users/by-telegram-id/{tgId}` → **200 + `{"response": []}`** для несуществующего
  telegramId (НЕ 404) — «юзера нет» определяется пустым массивом.
- `POST /api/users/{uuid}/actions/revoke` (тело `{}`) → **200**, у юзера НОВЫЙ `shortUuid`
  и `subscriptionUrl` (старая ссылка умирает сразу), `expireAt` сохраняется,
  проставляется `subRevokedAt`. Это и есть «обновить ссылку» — юзер панели тот же.
- `DELETE /api/users/{uuid}` → **200 + `{"response":{"isDeleted":true}}`**.

Реализация: Zod-контракт — `packages/types/src/remnawave.ts`; HTTP-клиент —
`apps/web/lib/remnawave/` (Bearer из `REMNAWAVE_API_TOKEN`, timeout 10s, без ретраев);
флоу бота — `apps/web/lib/telegram/vpn-flow.ts` (callback `vpn` / `vpn:refresh`);
снимок — таблица `vpn_subscriptions` (миграция 0024). Продление по оплате — следующий этап.
