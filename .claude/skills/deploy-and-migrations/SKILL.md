---
name: deploy-and-migrations
description: Процедуры выката и применения миграций на прод «Оплатишки», а также где лежат Telegram-секреты и как их менять. Use when: применяешь миграцию на прод-БД, разбираешь красный /api/ready или «migrations_pending», лезешь на VPS через ssh к oplatishka-db, меняешь TELEGRAM_BOT_TOKEN/TELEGRAM_WEBHOOK_SECRET или переставляешь webhook бота. NOT for: инварианты деплоя и запреты (они в CLAUDE.md), устройство VPS и Dokploy (docs/reference/infrastructure.md), пошаговый рунбук выката (docs/runbooks/deploy.md).
---

# Деплой, миграции и Telegram-секреты — процедуры

Запреты и инварианты живут в `CLAUDE.md` («Миграции БД», «Deployments»). Здесь — только то,
что нужно в руках в момент операции.

## Почему невыкаченные миграции больше не молчат

С 2026-07-29 такая схема больше не молчит: **`GET /api/ready`** сравнивает журнал миграций, запечённый в образ (`@oplati/db/migrations-journal`), с журналом `drizzle.__drizzle_migrations` в живой БД — И самую свежую отметку, И ЧИСЛО применённых (по одной отметке проверка обманывается на пропуске В СЕРЕДИНЕ: применили только последнюю — её `when` максимален — и readiness зелёный при недостающих предыдущих), и шаг «Проверить готовность релиза» в `deploy.yml` делает деплой красным с текстом «код выкачен, миграции НЕ применены». Liveness `/api/health` при этом БД по-прежнему не трогает (иначе моргнувшая база перезапускала бы контейнеры). Применение миграций всё равно остаётся ручным шагом — автоматизировали только обнаружение.

## Применение миграции на прод-БД

Прод-БД снаружи недоступна, поэтому применение — с VPS:

```bash
# 1. что уже применено (hash в журнале = sha256 файла миграции)
ssh root@187.124.172.104 "docker exec \$(docker ps --filter name=oplatishka-db-ry3smb -q) \
  psql -U oplatishka -d oplatishka -t -A -c \
  'select id, hash from drizzle.__drizzle_migrations order by id desc limit 3'"
shasum -a 256 packages/db/migrations/00XX_*.sql   # сверить, чего не хватает

# 2. применить SQL через docker exec (порядок — docs/reference/infrastructure.md), затем ОБЯЗАТЕЛЬНО
#    дописать журнал, иначе следующий db:migrate применит миграцию повторно:
#    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
#      VALUES ('<sha256 файла>', <when из migrations/meta/_journal.json>);
```

Пошагово — [`docs/runbooks/deploy.md`](docs/runbooks/deploy.md); автоматизация шага (нужен ssh-ключ в секретах GitHub) — в [`docs/BACKLOG.md`](docs/BACKLOG.md).

## Telegram-секреты (где что лежит, без значений)

> Реальные токены — только в env приложения Dokploy и локальном `.env.local`/`.env`
> (gitignored). Никогда не пастовать в файлы, коммиты, чат. Компрометация: `/revoke` у
> `@BotFather`, `openssl rand -hex 32` для нового webhook-secret.

| Бот | Где env | Локально |
|---|---|---|
| `@oplatishkaa_bot` (prod) | приложение `oplatishka-web` в Dokploy: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` |
| `@dev_test_podpiska_bot` (dev) | приложение `oplatishka-web-dev`: те же имена, dev-значения | `TELEGRAM_BOT_TOKEN_DEV`, `TELEGRAM_WEBHOOK_SECRET_DEV` |
| `@oplatishkaasupport_bot` (бот ПЕРСОНАЛА: вход в панель + уведомления сотрудникам) | приложение `oplatishka-web`: `TELEGRAM_LOGIN_BOT_TOKEN`, `TELEGRAM_LOGIN_BOT_USERNAME`, `TELEGRAM_LOGIN_BOT_WEBHOOK_SECRET` | `TELEGRAM_LOGIN_BOT_TOKEN`, `TELEGRAM_LOGIN_BOT_USERNAME` |

⚠️ У бота персонала свой приёмник `/api/staff-bot` со своим секретом, а `/api/admin/telegram-webhook`
переставляет webhook ТОЛЬКО клиентского бота — для персонала `setWebhook` делается вручную
(`curl https://api.telegram.org/bot<token>/setWebhook -d url=https://new.oplatishka.com/api/staff-bot -d secret_token=<secret>`,
токен в чат не вставлять — брать из env). При смене бота персонала обязателен `/setdomain` у
@BotFather на `admin.oplatishka.com` — иначе кнопка входа молча не появится (`oauth.telegram.org/embed/<bot>` → `Bot domain invalid`).

Env правится в панели Dokploy (или API — ⚠️ перезаписывает блок ЦЕЛИКОМ, порядок с бэкапом
в [`docs/runbooks/deploy.md`](docs/runbooks/deploy.md)); **после смены секрета обязателен
редеплой** — контейнер держит значение с момента старта и до перезапуска отвечает `401`.
Полный список переменных — [`docs/reference/env-vars.md`](docs/reference/env-vars.md).

**Webhook у бота один** — dev-бот и прод-бот потому и разные. Смена адреса без раскрытия
токена: `POST/GET/DELETE /api/admin/telegram-webhook` (защита `X-Internal-Token`).
