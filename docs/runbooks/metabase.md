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

## Пароли

В репозитории не хранятся. Пароль админ-аккаунта, роли `metabase_ro` и env
`MB_DB_PASS` — у владельца; env-переменная лежит в Dokploy у compose-сервиса.
Ротация роли:

```sql
ALTER ROLE metabase_ro PASSWORD '<новый>';
```

затем обновить пароль подключения в Metabase (Admin → Databases).
