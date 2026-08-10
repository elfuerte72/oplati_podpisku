# Ось J — Конфигурация, env, флаги, дублированные константы

Прод живёт на Dokploy/VPS; деплой НЕ применяет миграции; env правится руками.
Значит, класс ошибок «код разъехался с конфигом/схемой/докой» ловится только
аудитом. Проверяется по коду; live-сверку прод-env этот аудит НЕ делает.

## J1 · env-схема (`apps/web/lib/env.ts`)

- Каждый `process.env.X`, читаемый где-либо в коде, объявлен в Zod-схеме env
  (lazy). Чтение мимо схемы — находка.
- `env.server.ts` — `server-only`: серверные секреты недостижимы из клиентских
  бандлов. Проверить, что ни один секрет не утекает в `NEXT_PUBLIC_*` и в
  client-компоненты.
- Дефолты в коде соответствуют задокументированным: `COMMISSION_PERCENT` 10
  (прод 30), `CARD_ISSUE_FEE_USD_CENTS` 0 (прод 400), `RATE_FALLBACK_USDT_RUB`
  81, `PAYSPACE_CARD_BUFFER_PERCENT` 0 (прод 20), `FREEKASSA_BUYER_FEE_PERCENT`
  6 (прод 0), `FREEKASSA_MAX_AMOUNT_RUB` 140000, `INVOICE_TTL_HOURS` 1,
  TTL фиксации цены 2 часа, `CARD_LIFETIME_DAYS` 180.

## J2 · Fail-open vs fail-closed — таблица осознанных решений

Сверить код с решениями (отклонение в ЛЮБУЮ сторону — находка):

| Механизм | Решение |
|---|---|
| Rate-limit без Upstash env | fail-open (осознанно) |
| AI-бюджет при недоступной БД | fail-open (осознанно) |
| Haiku-роутер при ошибке | fail-open в агента |
| `CRON_SECRET` | fail-closed |
| `getClientIp` невалидный правый XFF | fail-closed → `unknown`, БЕЗ добора левее |
| `X-Client-IP` без совпадения `PROXY_SHARED_SECRET` | ветка мертва |
| `SUPPORT_OPERATOR_CHAT_ID` не задан | не доставляется + Sentry (дефолта в коде НЕТ) |
| `wouldCreateCycle` при сбое обхода | fail-closed (отказ установки) |
| PaySpace ключей нет | guard `skipped_no_paypace`, заказ остаётся в `paid` |

## J3 · Дублированные константы (нет единого источника — сверять руками)

- Потолок $1200 (`HIGH_VALUE_SERVICE_SLUGS`): `lib/telegram/amount.ts`,
  `StartScreen.tsx`, `CatalogView.tsx` + серверная граница — все равны.
- `roundUpToWholeRubles`: ОБЕ точки расчёта (`lib/catalog/build.ts` и
  `lib/tool-handlers/propose-order.ts`) зовут одну функцию; округляются строки
  «подписка» и «выпуск карты», НЕ итог.
- `CARD_LIFETIME_DAYS` — одно число в `@oplati/types/card-lifecycle`; кабинет
  показывает МИНИМУМ из него и `exp_date` (`cardValidUntil`).
- Двухэшелонный потолок: витринный кап $1200 и рублёвый гейт
  `FREEKASSA_MAX_AMOUNT_RUB` (`422 above_max_amount`) + симметричная проверка
  в фоллбэке.

## J4 · Флаги — дефолт и оба состояния

Для каждого флага: дефолт совпадает с задокументированным, ОБА состояния
рабочие (выключенное не зовёт платных внешних систем, включённое не обходит
защиты): `BOT_AI_ENABLED` (выкл), `WEB_AI_ENABLED` (выкл),
`ALLOW_OWN_VARIANT` (false), `REFERRAL_ENABLED`, `REFERRAL_MINIAPP_DEEPLINK`
(выкл), `PAYMENT_AUTO_FALLBACK` (выкл), `PAYMENT_PRIMARY_PROVIDER`
(дефолт `loveandpay`, прод `freekassa` — вебхуки ОБОИХ работают всегда),
`AI_ROUTER_DISABLED`, `RATE_LIMIT_DISABLED`, `CLIENT_IP_MODE` (дефолт
`traefik`).

## J5 · Миграции ↔ код

- Число/содержимое миграций в `packages/db/migrations/` согласовано с
  `schema.ts` (нет схемы без миграции и наоборот).
- `GET /api/ready` сравнивает запечённый журнал (`@oplati/db/migrations-journal`)
  с `drizzle.__drizzle_migrations`; `/api/health` БД не трогает (liveness).
- Enum-расширения — ОТДЕЛЬНОЙ миграцией от использующего DDL/DML.
- Новые миграции backwards-compatible (nullable-колонки; destructive — в два
  деплоя): код, который упадёт на прод-БД без свежей миграции при старте
  (а не при первом использовании фичи), — HIGH (инцидент `freekassa_nonce`).

## J6 · Легаси и мёртвый код

- Известное легаси (НЕ находки, если не активируются случайно): роут
  `keepalive`, callback `channel`, режим `CLIENT_IP_MODE=vercel`, ветки
  `VERCEL_URL`, конфиг `/opt/lnp-proxy` (оставлен для отката).
- Находки: легаси-путь, достижимый в текущей конфигурации по умолчанию;
  удалённая фича, на которую остались живые ссылки (кнопки, роуты, actions —
  ср. удалённые `repeat`/`operator` в `/api/cabinet`).
- CI/деплой: `deploy.yml` — гейт тестов перед деплоем, проверка `startedAt`,
  `paths-ignore` для доков; секреты не светятся в логах workflow.
