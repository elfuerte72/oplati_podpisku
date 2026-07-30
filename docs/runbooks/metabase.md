# Metabase — вопросы к боевой БД без SQL

Развёрнут 2026-07-28 шаблоном Dokploy в проекте `oplatishka`, окружение
`production`. Это инструмент чтения аналитики, а не часть контура оплаты: его
падение ничего не ломает.

| | Значение |
|---|---|
| Compose-сервис Dokploy | `metabase` (`composeId` `fQYQ_GBdk-g7eMnAAPJLz`, appName `oplatishka-metabase-8mi7hv`) |
| Контейнеры | `…-metabase-1` (образ `metabase/metabase:v0.63.1.8`), `…-postgres-1` (`postgres:17-alpine`) |
| Свои метаданные | БД `metabaseappdb` в собственном Postgres, том `metabase-appdb` |
| Публичный домен | **нет** (решение владельца 2026-07-28) |
| Вход | ssh-туннель на `127.0.0.1:3001` VPS |
| Роль в боевой БД | `metabase_ro` — только `SELECT`, см. ниже |

## Как зайти

```bash
ssh -L 3001:127.0.0.1:3001 root@187.124.172.104
# в браузере: http://localhost:3001
```

Порт 3001 опубликован **только на loopback** VPS (`127.0.0.1:3001:3000` в
compose), снаружи он не слушается и дополнительно закрыт firewall'ом Hostinger.
Автодомен, который шаблон создаёт сам (`*.sslip.io`, HTTP без TLS), удалён при
развёртывании: незасетапленный Metabase в открытом доступе означает «кто первым
зашёл, тот и админ». Если однажды понадобится домен — заводить по образцу
`dokploypanel`: A-запись на VPS, Traefik-роутер с `basicAuth` и `certResolver:
letsencrypt`, и только потом публиковать.

## Доступ к данным: роль `metabase_ro`

Приложение ходит в БД суперюзером — этой ролью Metabase подключать нельзя.
Создана отдельная роль:

- `LOGIN`, `CONNECTION LIMIT 8`, `default_transaction_read_only = on`,
  `statement_timeout = 120s` (тяжёлый запрос аналитика не положит боевую БД);
- **`BYPASSRLS` обязателен**: RLS включён на всех таблицах, а политик под
  обычную роль нет (инвариант 8 в `CLAUDE.md`) — без него любой запрос вернул бы
  ноль строк. Обходится только row-level фильтр; права остаются ровно
  выданными, запись невозможна (нет грантов + read-only транзакции).

Выдано `SELECT` на: `orders`, `order_events`, `services`, `ai_usage_daily`,
`cards`, `conversations`, `referral_accruals`, `referral_monthly_stats`,
`referral_partners`, `vpn_subscriptions`, `staff`; на `payments` — без
`raw_payload`; на `users` — только `id`, `language`, `created_at`, `updated_at`,
`referred_by`, `referral_code`, `referred_by_set_at`; на `referral_payouts` — без
`destination`.

**Намеренно НЕ выдано:** `messages` (личная переписка клиентов), `attachments`,
`link_tokens`. `ALTER DEFAULT PRIVILEGES` тоже не ставился — новая таблица не
должна появляться в BI сама собой, грант выдаётся осознанно:

```bash
ssh root@187.124.172.104 'docker exec $(docker ps --filter name=oplatishka-db-ry3smb -q) \
  psql -U oplatishka -d oplatishka -c "GRANT SELECT ON <таблица> TO metabase_ro"'
```

После нового гранта — в Metabase «Admin → Databases → Sync database schema»,
иначе таблица не появится.

## Грабли

- **Шаблон Dokploy устарел и терял данные.** В блюпринте `metabase:v0.50.8`,
  пароль `mysecretpassword` и Postgres **без тома** — при первом же redeploy
  дашборды и пользователи уехали бы в никуда. Развёрнутый compose переписан:
  актуальный образ, именованный том, пароль в env-переменной Dokploy,
  `depends_on: service_healthy`, `JAVA_OPTS=-Xmx1500m`.
- **Healthcheck шаблона врёт про unhealthy на старте.** Metabase поднимается
  дольше, чем `retries: 5 × 15s`; добавлен `start_period: 90s`.
- **Autoгенерируемый домен указывал на IP старого бостонского VPS**
  (`…-177-7-34-106.sslip.io`): в настройках Dokploy остался прежний `serverIp`
  после переезда 2026-07-27. На наши роутеры это не влияет (они заданы файлами
  Traefik), но любой сгенерированный панелью домен будет неверным.
- Компонент подключён к `dokploy-network` (она `attachable`) — иначе не виден ни
  боевой Postgres (`oplatishka-db-ry3smb:5432`), ни Traefik.

## Поведенческая аналитика: доступ и готовые вопросы

Таблицы `analytics_events` / `analytics_event_types` и вьюхи
`analytics_timeline`, `analytics_user_path`, `analytics_funnel` появляются
миграциями `0028`/`0029`. Словарь подписей наполняет cron `retention`
(идемпотентный upsert из `packages/types/src/analytics.ts`) — отдельного шага
после деплоя не требуется, но первый прогон случится в 04:15.

**Гранты после применения миграций** (без них Metabase таблиц не увидит —
`ALTER DEFAULT PRIVILEGES` у нас намеренно не стоит):

```bash
ssh root@187.124.172.104 'docker exec $(docker ps --filter name=oplatishka-db-ry3smb -q) \
  psql -U oplatishka -d oplatishka -c "
    GRANT SELECT ON analytics_events, analytics_event_types TO metabase_ro;
    GRANT SELECT ON analytics_timeline, analytics_user_path, analytics_funnel TO metabase_ro;
  "'
```

Затем в Metabase — «Admin → Databases → Sync database schema».

⚠️ **Почему через вьюху, а не через гранты на `users`.** `metabase_ro` не имеет
`SELECT` на `users.telegram_id` и `users.web_session_id` (см. список колонок
выше), а резолв личности в аналитике — это JOIN именно по ним. Обычная вью в
Postgres выполняется с правами СВОЕГО ВЛАДЕЛЬЦА, поэтому грант на вьюху даёт
доступ к пути клиента, не расширяя доступ к таблице `users`. Наружу отдаётся
ровно то, что перечислено во вьюхе: `user_id`, `telegram_id`, `web_session_id`,
событие и props — но не `display_name`, не `phone`, не `email`.

### Вопрос «Путь пользователя»

Ищем по Telegram-ID (его же присылает клиент в жалобе):

```sql
SELECT to_char(occurred_at, 'DD.MM HH24:MI:SS')     AS "время",
       coalesce(to_char(pause, 'MI:SS'), '—')       AS "пауза",
       'заход ' || session_no                        AS "заход",
       channel                                       AS "канал",
       title                                         AS "что сделал",
       description                                   AS "что это значит",
       coalesce(order_ref, '')                       AS "заказ",
       props
FROM analytics_user_path
WHERE telegram_id = {{telegram_id}}
ORDER BY occurred_at DESC
LIMIT 200;
```

Строки с `kind = 'milestone'` — денежные вехи из `order_events`, они были и до
включения аналитики. Сессия («заход») считается по разрыву 30 минут прямо в
запросе: чтобы изменить длину сессии, правится запрос, а не накопленные данные.

### Вопрос «Воронка»

```sql
SELECT step AS "шаг", title AS "этап", subjects AS "человек"
FROM analytics_funnel ORDER BY step;
```

⚠️ Шаги 1–3 (сайт) наполняются только с момента включения телеметрии, шаги 4–7
— за всю историю проекта. Сравнивать проценты между этими группами до
накопления данных нельзя.

### Вопрос «Гейт привязки Telegram»

Самостоятельный вопрос, а НЕ шаг воронки: привязка обязательна только для
пришедших с сайта.

```sql
SELECT count(*) FILTER (WHERE name = 'telegram_link_click') AS "нажали кнопку",
       count(*) FILTER (WHERE name = 'telegram_linked')     AS "привязались"
FROM analytics_timeline
WHERE occurred_at > now() - interval '30 days';
```

### Вопрос «Бот промолчал»

Пока `BOT_AI_ENABLED` выключен, бот не отвечает на текст. Сколько людей в это
упирается, не видно больше нигде:

```sql
SELECT date_trunc('day', occurred_at)::date AS "день",
       count(*)                              AS "случаев",
       count(DISTINCT telegram_id)           AS "человек"
FROM analytics_events
WHERE name = 'bot_text_ignored'
GROUP BY 1 ORDER BY 1 DESC;
```

### Чего в аналитике нет

- **Нажатий url-кнопок в боте** — Telegram о них не сообщает вообще: «Сайт»,
  канал, кнопки сторов и ссылка оплаты. `pay_link_click` есть только для сайта
  и Mini App.
- **Событий на доменах платёжного провайдера и сервиса-подписки** — там мы вне
  периметра.
- **Переписки.** `messages` закрыт для `metabase_ro` намеренно, и события
  текста клиента не содержат: у `bot_text_ignored` пишется только длина.

## Пароли

В репозитории не хранятся. Пароль админ-аккаунта, роли `metabase_ro` и env
`MB_DB_PASS` — у владельца; env-переменная лежит в Dokploy у compose-сервиса.
Ротация роли:

```sql
ALTER ROLE metabase_ro PASSWORD '<новый>';
```

затем обновить пароль подключения в Metabase (Admin → Databases).
