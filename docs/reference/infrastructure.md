# Инфраструктура: VPS, Dokploy, деплой

Где физически живёт контур, как устроены прод- и dev-стенды, как работает деплой и что на VPS
настроено руками мимо панели.

Выделено из `CLAUDE.md` 2026-08-14 — там осталось только то, что нужно знать при любой работе:
где прод, чем деплоится и что деплой не применяет миграции. Пошаговые процедуры — в
[`../runbooks/deploy.md`](../runbooks/deploy.md), переезд контура — в
[`../runbooks/server-migration.md`](../runbooks/server-migration.md).


**С 2026-07-27 прод и dev живут на Dokploy/VPS `187.124.172.104` — Hostinger, дата-центр
Франкфурт (`data_center_id: 19`), KVM 2: 2 vCPU / 8 ГБ / 96 ГБ.** Машина отдана
**только** Оплатишке, это осознанное условие: до неё контур стоял на бостонском VPS
`177.7.34.106`, где делил два ядра с VPN-панелью Remnawave, dev-стендом и личным ботом —
`idle` упал до 1%, гипервизор начал отбирать до 50% CPU (`%steal`), а до РФ было ~140 мс RTT
против ~40 мс из Франкфурта. Порядок работ и грабли переезда —
[`docs/runbooks/server-migration.md`](docs/runbooks/server-migration.md), цифры разбора —
[`docs/CHANGELOG.md`](docs/CHANGELOG.md) за 2026-07-27.

## Что где живёт

**Весь контур Оплатишки — на этом одном VPS:** приложение, обе БД, Redis, cron, Traefik.
Ни Vercel, ни реверс-прокси, ни Supabase в схеме не участвуют (проверено на живом проде
2026-08-14: `www.oplatishka.com` резолвится в `187.124.172.104`, `CLIENT_IP_MODE=traefik`,
`PROXY_SHARED_SECRET` и `MINIAPP_BASE_URL` не заданы). Прошлые контуры и их грабли —
[`docs/history/vercel-era.md`](docs/history/vercel-era.md) и
[`docs/history/dokploy-cutover-report.md`](docs/history/dokploy-cutover-report.md).

⚠️ **Одно исключение — VPN-панель Remnawave `panel.mxpkn8ns.ru`: она осталась на бостонском
VPS `177.7.34.106`** (проверено 2026-08-14, отвечает), и кнопка «VPN» в боте ходит туда. Там же
личный бот `Vanya_bot`, свой Dokploy и остановленная прод-БД `oplatishka-db-ry3smb` — холодный
резерв эпохи переезда; погашен он или нет, по коду не видно, разбор в
[`docs/BACKLOG.md`](docs/BACKLOG.md).

Таблица стендов (домены, БД, боты, модели, ключи) живёт в `CLAUDE.md` — она нужна при
любой работе, поэтому не дублируется здесь.

## Панель Dokploy

**Панель Dokploy — `https://dokploypanel.oplatishka.com`, под basic-auth.** Порт 3000 наружу
закрыт firewall'ом Hostinger (`oplatishka-fra-prod`, снаружи открыты только 22/80/443), поэтому
единственный путь в панель — 443 через Traefik, где стоит basic-auth поверх собственного логина
Dokploy. Исключение ровно одно: `/api/deploy` (файл `dokploy-deploy-hook.yml`) — иначе CI
получал бы 401 вместо сборки; роут защищён узким `refreshToken`, который не даёт доступа к панели.
⚠️ Из-за basic-auth команды к API панели по внешнему адресу требуют `-u`; проще ходить с самого
VPS на `http://127.0.0.1:3000` — Traefik и basic-auth при этом не участвуют.

## Админ-панель `admin.oplatishka.com`

**Отдельного приложения в Dokploy у панели НЕТ и быть не должно.** Панель — часть
`apps/web` (кросс-импорты между `apps/*` запрещены, а ей нужны `lib/telegram`,
`lib/pay-space`, `lib/alerts`), поэтому Traefik просто ведёт её домен на тот же
сервис `oplatishka-web-<хеш>:3000`. Второе приложение означало бы вторую сборку
того же образа и дубль всех 46 переменных окружения.

Разделение держится ДВУМЯ вещами, ни одна из которых не в Traefik:

- `apps/web/proxy.ts` — гейт по хосту: при заданном `PANEL_HOST` любой запрос к
  `/admin` и `/api/panel` с чужого домена получает пустой 404;
- проверка прав в КАЖДОЙ операции панели (`lib/panel/session.ts`).

Маршрут — файл `/etc/dokploy/traefik/dynamic/oplatishka-admin.yml` (шаблон в
репозитории: `infra/traefik/oplatishka-admin.yml.example`, в нём `__WEB_SERVICE__`
заменяется на реальное имя сервиса). Откат — удалить файл: Traefik подхватит за
секунды, приложение при этом живёт.

⚠️ **`/api/staff-bot` живёт на ПУБЛИЧНОМ домене, а не на домене панели** — до
вебхука должны дотягиваться серверы Telegram, а домен панели у них не
зарегистрирован. Защищён своим `X-Telegram-Bot-Api-Secret-Token`.

### Что нужно, чтобы панель заработала на новом контуре

1. DNS: A-запись `admin.<домен>` на IP VPS (зона на Cloudflare, режим DNS-only —
   отдавать надо наш IP, а не прокси-адрес).
2. Файл Traefik (см. выше) + подстановка имени сервиса.
3. Env приложения: `PANEL_HOST`, `ADMIN_SESSION_SECRET`, `TELEGRAM_LOGIN_BOT_TOKEN`,
   `TELEGRAM_LOGIN_BOT_USERNAME`, `TELEGRAM_LOGIN_BOT_WEBHOOK_SECRET` + редеплой.
4. Вебхук бота персонала: `setWebhook` на `https://<публичный домен>/api/staff-bot`
   с тем же secret-token (`/api/admin/telegram-webhook` управляет ТОЛЬКО
   клиентским ботом — этот регистрируется отдельно).
5. Сотрудник в таблице `staff`: `pnpm --filter @oplati/db db:staff add …`.
6. ⚠️ **`/setdomain` у @BotFather** — см. ниже.

### ⚠️ `/setdomain` — шаг, который молчит, если его забыть

Telegram Login Widget рисует кнопку, только если у бота привязан домен:
@BotFather → `/setdomain` → бот персонала → `admin.oplatishka.com`.

Без этого страница входа отдаёт **пустую рамку**, и узнать причину неоткуда:
скрипт виджета грузится (200), CSP пропускает, в логах приложения ничего нет,
консоль браузера молчит. Диагноз виден только со стороны Telegram:

```bash
curl -s "https://oauth.telegram.org/embed/<bot_username>?origin=https%3A%2F%2Fadmin.oplatishka.com" \
  | grep -o "Bot domain invalid"
```

Домен привязывается ТОЛЬКО вручную у @BotFather — метода Bot API для этого нет.

## Hardening VPS

**Безопасность VPS (2026-07-27):** SSH только по ключу (`PasswordAuthentication no`,
`PermitRootLogin prohibit-password`, `MaxAuthTries 3` — файл `sshd_config.d/00-hardening.conf`,
именно `00-`, потому что sshd берёт ПЕРВОЕ найденное значение, а `50-cloud-init.conf` ставит
`yes`); fail2ban на sshd; unattended-upgrades; firewall Hostinger. Плюс swap 2 ГБ
(`vm.swappiness=10`) и ротация docker-логов (`/etc/docker/daemon.json`, 10 МБ × 3) — без неё
json-file растёт неограниченно.

## Деплой

**Деплой — ТОЛЬКО через `.github/workflows/deploy.yml`** (push в `main`/`dev` → gate
typecheck+тесты+lint → `POST /api/deploy/<refreshToken>` → **проверка, что прод реально
обновился**: `/api/health` отдаёт `startedAt` позже момента триггера, иначе workflow красный;
провал любого шага → сообщение в Telegram, если заданы `DEPLOY_ALERT_BOT_TOKEN`/`DEPLOY_ALERT_CHAT_ID`).
Принятый триггер не равен выкаченному релизу — до 2026-07-25 пайплайн заканчивался на «сборка
запущена», и упавшая сборка давала зелёный workflow при старом коде на проде. **`curl exit 28`
в деплое — это внешние эпизоды сетевой недоступности VPS с раннеров GitHub, а НЕ нагрузка от
собственной сборки** (последнее проверено и опровергнуто: `sar` в разгар падения показал load
average 0.25); отсюда `--connect-timeout 10` и 10 попыток — см. [`docs/incidents.md`](docs/incidents.md).
GitHub App Dokploy как источник
триггера больше не используется: он деплоил сразу на push, не дожидаясь CI (красный `main` уехал бы
на боевой контур с живыми платежами), а его отказы не видны из репозитория — вебхук молча потерял
мерж PR #102 и #103, прод пересобирали руками. **С 2026-07-25 установлено: App не «иногда теряет
события», а не работает вообще** — все доставки в его журнале красные (Dokploy отвергает их на
проверке подписи), проверено экспериментом с docs-коммитом, который наш workflow пропускает.
Решение владельца — не чинить. ⚠️ Отвязывать git-провайдера или сужать Repository access **нельзя**:
Dokploy клонирует репозиторий по токену этой установки, сломается и workflow-деплой; глушить App
следует снятием подписки на события — [`docs/runbooks/deploy.md`](docs/runbooks/deploy.md). Ровно та же история была с вебхуком Vercel
(PR #83, 2026-07-18, см. [`docs/incidents.md`](docs/incidents.md)).

## Контракт deploy-вебхука Dokploy

**Контракт deploy-вебхука Dokploy (в доках его НЕТ, снят перебором 2026-07-25):**
`POST /api/deploy/<refreshToken>` + заголовок **`X-GitHub-Event: push`** + тело
**`{"ref":"refs/heads/<ветка>"}`** → `200 {"message":"Application deployed successfully"}`.
Без заголовка Dokploy не умеет достать ветку → `301 {"message":"Branch Not Match"}`; ветка обязана
совпасть с `branch` приложения; неизвестный токен → `404 Application Not Found`. Подпись HMAC этому
роуту не нужна (в отличие от `/api/deploy/github`, требующего `X-Hub-Signature-256`).
⚠️ **Флаг `autoDeploy` у приложения обязан быть ВКЛЮЧЁН**, хотя триггер у нас свой: несмотря на
название, это общий выключатель вебхук-деплоев, а не «слушать GitHub App». При выключенном Dokploy
отвечает `400 {"message":"Automatic deployments are disabled for this application"}` и на наш
собственный вызов (проверено на живом проде 2026-07-25).
Токены — в секретах репозитория `DOKPLOY_DEPLOY_TOKEN_PROD`/`DOKPLOY_DEPLOY_TOKEN_DEV`; они узкие
(триггерят сборку ровно одного приложения, не админский `DOKPLOY_API_KEY`), ротация — кнопка
refresh token в Dokploy + обновить секрет.
⚠️ `gh secret set --body -` НЕ читает stdin, а пишет литерал `-` — задавать через
`gh secret set NAME < file`.

## Работа с dev-БД

**Миграции/seed на dev-БД — ТОЛЬКО с VPS, снаружи она недоступна** (найдено
2026-07-27). ⚠️ `DEV_DATABASE_URL`/`DEV_DATABASE_URL_DIRECT` в корневом `.env`
указывают на **мёртвую dev-Supabase эпохи Vercel** — seed по ним отрабатывает
«успешно» и уходит в никуда, приложение изменений не видит. Настоящая dev-БД —
контейнер `oplatishka-db-dev-*` в overlay-сети swarm: порт наружу не
опубликован, ssh-туннель на IP контейнера (`10.0.1.x`) не проходит. Рабочий
путь — прогнать SQL через `docker exec` на VPS:
```bash
base64 -i my.sql | ssh root@187.124.172.104 "base64 -d > /tmp/q.sql && \
  docker exec -i \$(docker ps --filter name=oplatishka-db-dev -q) \
  psql -U oplatishka -d oplatishka < /tmp/q.sql; rm -f /tmp/q.sql"
```
Строка подключения (с паролем) лежит в env dev-приложения Dokploy. Прод-БД —
так же, контейнер `oplatishka-db-ry3smb`. Shell-env имеет приоритет над
`--env-file` (тот же приоритет у `db:init-roles`) — это по-прежнему верно.

⚠️ **Каталог сервисов живёт в БД, а не в коде.** Мерж в `main` НЕ добавит новый
сервис в витрину: после деплоя нужно отдельно применить seed к прод-БД. Витрина
кэшируется в памяти инстанса 5 минут (`lib/catalog/load.ts`).

⚠️ **dev-домен под Basic Auth, а Telegram его не умеет.** WebView Mini App и
серверы Telegram (скачивают картинки для `sendMediaGroup`) получают `401`.
Исключения вынесены отдельными файлами Traefik на VPS, Dokploy их не
перегенерирует: `oplatishka-dev-webhook.yml` (`/api/bot`) и
`oplatishka-dev-miniapp.yml` (`/cabinet`, `/api/cabinet`, `/api/catalog`, `/_next`, картинки).
⚠️ Список путей — исчерпывающий по факту: пропущенный `/api/catalog` давал
открывшийся кабинет с пустым экраном «Каталог не открылся». При добавлении
экранов в Mini App сверять `grep -rhoE "'/api/[a-z/_-]*'" components/cabinet`.
Данные не открыты: `/api/cabinet` проверяет подпись `initData` на каждом
запросе, сам сайт `/` остаётся под Basic Auth.
Локальная разработка (`pnpm dev`) ходит в dev-БД, не в прод.

## Пайплайн и защита main

**Пайплайн:** feature-ветка → push → PR → CI (`Tests`/`Type Check`/`Lint`/`Build`/`Secret Scan`) →
squash в `main` → workflow `Deploy` пересобирает прод. `Build` отдельно от `Type Check`, потому что
`tsc --noEmit` не видит ошибок пререндера и конфигурации route-сегментов — такой коммит раньше
падал уже при docker build на VPS. `Secret Scan` (gitleaks) — репозиторий публичный, а `.gitignore`
ловит только известные имена файлов; ⚠️ глубина скана зависит от события: на `pull_request` он
читает только коммиты PR, всю историю — лишь `schedule`/`workflow_dispatch`, и в `.gitleaksignore`
нельзя цитировать найденную строку (файл сканируется наравне с остальными). **Main защищён ОДНИМ ruleset'ом
`protectionOplatishka`** (2026-07-25 дубль `protect-main` удалён — при двух наборах правил GitHub
применяет самое строгое из каждого, и удаление «лишнего» молча ослабило бы защиту): прямой push
запрещён, только PR с зелёными `Tests`/`Type Check`/`Lint`/`Build`/`Secret Scan`/`Dependency Review`
(approvals 0 — solo, сам себе аппрув GitHub не даёт); merge-метод только **squash**; force-push и
удаление ветки заблокированы. `Dependency Audit` в обязательные НЕ входит осознанно: у него внутри
`continue-on-error` (у pnpm сломан audit-эндпоинт), он физически не может упасть — гейт по
уязвимостям даёт `Dependency Review`. Новый чек делать обязательным можно только после нескольких
зелёных прогонов: падающий по своей же ошибке required-чек блокирует разом все merge.
Для dev-стенда — push в `dev` (до 2026-07-25 у этой ветки
не было CI вообще; теперь она под тем же гейтом внутри `deploy.yml`).

## Автовыравнивание dev

**`dev` выравнивается по `main` автоматически** (шаг «Выровнять dev по main после релиза» в
`deploy.yml`, 2026-07-30): после каждого успешного деплоя `main` ветка `dev` переставляется на тот
же коммит. Причина — squash-мерж схлопывает коммиты PR, поэтому `dev` перестаёт быть предком
`main` и git видит ветки расходящимися при одинаковом содержимом: `git merge main` в `dev` даёт
конфликт `add/add` в файле, который в обе ветки принёс один и тот же PR. ⚠️ Шаг двигает ветку
ТОЛЬКО когда `compare/main...dev` не показывает ни одного изменённого файла, то есть в `dev` нет
ничего своего; иначе — `::warning::` и ветка не тронута (автосинк, молча стирающий незалитую
работу, хуже ручной синхронизации). Направление сравнения важно: `.files` в этом API — то, что
HEAD добавляет поверх BASE, а не полный diff, и с перепутанным `dev...main` шаг отказывался
работать ровно после релиза. Права `contents: write` выданы точечно job'у `deploy`.
⚠️ **Мерж только документации `dev` не выравнивает**: у workflow стоит `paths-ignore` на
`docs/**` и `**/*.md` (правка текста не должна пересобирать прод), поэтому шаг просто не
запускается и ветка остаётся на коммит позади. Это безвредно — следующий кодовый релиз выровняет
её сам, а до тех пор `dev` отличается от `main` только текстом доков.

