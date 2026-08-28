# Рунбук: деплой prod и dev

Контур — Dokploy на VPS `187.124.172.104`. Полная карта окружений (домены, БД, боты,
модели, какие ключи где) — в [`CLAUDE.md`](../../CLAUDE.md), раздел «Deployments».

---

## Как деплоится

**Единственный триггер — workflow [`Deploy`](../../.github/workflows/deploy.yml).**

```
push в main / dev
  → gate: pnpm typecheck + pnpm -r test + pnpm lint + pnpm build
  → POST https://dokploypanel.oplatishka.com/api/deploy/<refreshToken>   (до 10 попыток)
  → Dokploy собирает образ и подменяет контейнер
  → проверка: /api/health отдаёт startedAt, отличный от снятого до триггера
  → проверка готовности релиза: /api/ready (журнал миграций в образе = журнал в БД)
  → (только main) выровнять dev по main, если dev не ушёл вперёд
  → провал любого шага → сообщение в Telegram
```

Шаг проверки нужен потому, что принятый триггер не равен выкаченному релизу:
раньше пайплайн заканчивался на «сборка запущена», и упавшая сборка давала
зелёный workflow при старом коде на проде.

С 2026-07-28 проверка работает и для `dev`. До этого она стояла только на
`main`, и стенд молча оставался на прежней сборке при зелёном workflow —
поймано на переводе dev на текущий main. Стенд, на котором тестируют перед PR,
обязан доказывать свою версию так же, как прод: иначе тест проверяет не тот код.
dev закрыт Basic Auth, поэтому шаг ходит с парой `логин:пароль` из секрета
`DEV_HEALTH_AUTH` (значение — из Dokploy → приложение → Security). Секрет не
задан → шаг пропускается с warning, деплой не валится.

| Ветка | Приложение Dokploy | Секрет с токеном |
|---|---|---|
| `main` | `oplatishka-web` (прод) | `DOKPLOY_DEPLOY_TOKEN_PROD` |
| `dev` | `oplatishka-web-dev` | `DOKPLOY_DEPLOY_TOKEN_DEV` |

`main` защищён одним ruleset'ом `protectionOplatishka`: прямой push запрещён,
только PR с зелёными `Tests`/`Type Check`/`Lint`/`Build`/`Secret Scan`/
`Dependency Review`, merge-метод только squash, force-push и удаление ветки
заблокированы. Гейт внутри workflow — подстраховка на случай
`workflow_dispatch` и пушей в `dev`, у которого своего CI нет.

```bash
# посмотреть текущие правила
gh api repos/elfuerte72/oplati_podpisku/rulesets --jq '.[] | "\(.id)\t\(.name)"'
gh api repos/elfuerte72/oplati_podpisku/rulesets/19137923 \
  --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
```

Два правила, выведенные из собственных грабель 2026-07-25:

1. **Держать РОВНО ОДИН ruleset на ветку.** Их было два (`protect-main` +
   `protectionOplatishka`) с разными наборами: первый разрешал merge и rebase,
   второй — только squash. GitHub применяет самое строгое из каждого, поэтому
   разница не была видна, а удаление «лишнего» молча вернуло бы rebase-мерж.
   Дубль удалён, бэкап снят перед удалением.
2. **Новый чек делать обязательным только после нескольких зелёных прогонов.**
   Required-чек, падающий по собственной ошибке, блокирует разом все merge. Так
   вводили `Build`/`Secret Scan`.

`Dependency Audit` в обязательные не входит осознанно: внутри у него
`continue-on-error` (у pnpm сломан audit-эндпоинт), то есть упасть он не может и
как гейт бесполезен. Уязвимости гейтит `Dependency Review`.

Ручной перезапуск без коммита: `gh workflow run deploy.yml --ref main`.

---

## Порядок работы через dev-стенд

```
feature-ветка → push в dev → тест на dev.oplatishka.com → PR в main → CI → squash
             → прод пересобирается → dev выравнивается по main (шаг workflow)
```

Выравнивание обязательно: без него `dev` копит состояние, которого нет ни в
одной PR, и перестаёт что-либо доказывать. 2026-07-27..28 ветка разошлась с
`main` на 9 коммитов — стенд тестировал код, которого на проде уже не было.
С 2026-07-30 это шаг `deploy.yml` «Выровнять dev по main после релиза»: он
двигает `dev` на `main` ТОЛЬКО когда `compare/main...dev` пуст (на dev нет
своих коммитов). Если на dev параллельно проверяется вторая фича, шаг
пропускается, и выравнивание делается руками после её мержа:
`git push --force-with-lease origin origin/main:dev`.

**Чем dev отличается от прода — и что из этого следует для тестов**

| | Прод | Dev |
|---|---|---|
| Бот | `@oplatishkaa_bot` | `@dev_test_podpiska_bot` (вебхук на `dev.oplatishka.com/api/bot`) |
| Модель агента | `claude-sonnet-4-6` | Haiku, бюджет `AI_DAILY_TOKEN_BUDGET=100000` |
| AI-диалог | выключен обоими флагами | `BOT_AI_ENABLED=1` + `WEB_AI_ENABLED=1` — иначе путь `runAgent` не проверяется нигде |
| Приём денег | Freekassa (боевая касса) | **ключей нет** — см. ниже |
| Выпуск карт | PaySpace, боевой | ключей нет: тестовый заказ жёг бы $4 issue-fee и баланс VCC |
| Партнёрка | `REFERRAL_ENABLED` | не включена (решение владельца 2026-07-28) |
| VPN | Remnawave | тот же токен и **та же панель** |
| Sentry | подключён | намеренно нет: проект в Sentry один, dev-шум шёл бы теми же алёртами |
| Rate-limit | Redis + SRH | `RATE_LIMIT_DISABLED=1` |
| Cron | системный crontab бьёт по `www.oplatishka.com` | **не бегает вообще** |

Отсюда три ограничения, о которых надо помнить, планируя тест:

1. **Платёжный путь дальше кнопки «Оплатить» на dev не проверяется.** Выдать
   стенду ключи ТЕКУЩЕЙ кассы Freekassa нельзя: `nonce` обязан монотонно расти в
   пределах магазина, а последовательность `freekassa_nonce` у dev своя (своя
   БД). Пока dev ниже прода — отвергаются dev-запросы; как только dev обгонит
   прод, отказы начнёт получать **прод на боевых платежах**. Развести можно
   только отдельным магазином с независимым счётчиком, и это надо подтвердить у
   провайдера (привязан ли `nonce` к `shopId` или к аккаунту/API-ключу — дока
   не уточняет).
2. **Cron-джобы на dev не выполняются.** `expire-payments`, `poll-payment`,
   `recycle-cards`, метрика конверсии — вся эта логика проверяется только на
   проде. Чтобы завести их на стенде, недостаточно строки в crontab: dev под
   Basic Auth, а `Authorization` уже занят Bearer-токеном `CRON_SECRET` —
   понадобится исключение в Traefik по образцу `oplatishka-dev-webhook.yml`.
3. **VPN на dev трогает боевую панель.** Один `telegramId` = один пользователь
   Remnawave, поэтому проверка кнопки под своим аккаунтом работает с той же
   учётной записью, что и боевая, а «Обновить ссылку» (`revoke`) немедленно
   убивает действующую подписку. Для чистой проверки нужен отдельный telegram-аккаунт.

**Миграции на dev применяются так же вручную**, как на проде (см. ниже) — только
контейнер другой:

```bash
ssh root@187.124.172.104 'docker exec $(docker ps --filter name=oplatishka-db-dev -q) \
  psql -U oplatishka -d oplatishka -c "<SQL>"'
```

---

## Контракт deploy-вебхука Dokploy

**В документации Dokploy его нет** — снят перебором на живом контуре 2026-07-25.
Записан здесь, чтобы не выяснять второй раз.

```bash
curl -X POST "https://dokploypanel.oplatishka.com/api/deploy/<refreshToken>" \
  -H 'X-GitHub-Event: push' \
  -H 'Content-Type: application/json' \
  -d '{"ref":"refs/heads/main"}'
# → 200 {"message":"Application deployed successfully"}
```

| Что послали | Ответ |
|---|---|
| пустой POST | `301 {"message":"Branch Not Match"}` |
| `{"branch":"main"}` | `301 Branch Not Match` |
| `{"ref":"refs/heads/main"}` **без** заголовка | `301 Branch Not Match` |
| заголовок + `ref` | **`200 Application deployed successfully`** |
| неизвестный токен | `404 {"message":"Application Not Found"}` |
| при выключенном `autoDeploy` | `400 {"message":"Automatic deployments are disabled for this application"}` |

Без `X-GitHub-Event: push` Dokploy не умеет достать ветку из тела. Ветка обязана
совпасть с `branch` приложения. Подпись HMAC этому роуту **не** нужна — в отличие
от `/api/deploy/github`, который требует `X-Hub-Signature-256` от секрета GitHub App.

### Две грабли, стоившие прода

**1. Флаг `autoDeploy` обязан быть ВКЛЮЧЁН.** Несмотря на название, это не
«слушать GitHub App», а общий выключатель вебхук-деплоев. Выключив его ради
единственности триггера, мы обрубили и собственный workflow. Не выключать.

**2. `gh secret set --body -` не читает stdin** — он пишет литерал `-`. Токен
задавать через `gh secret set NAME < file` и проверять длину (21 байт, без
перевода строки).

---

## Если деплой упал с `curl exit 28`

Это не отказ Dokploy: TCP-соединение к 443 не устанавливается вовсе, до HTTP дело
не доходит. Наблюдались короткие эпизоды сетевой недоступности VPS со стороны
раннеров GitHub (маршрут Azure → Hostinger); панель, Traefik и ufw при этом
исправны, машина простаивает. Подробности и замеры — в
[`../incidents.md`](../incidents.md), запись 2026-07-25.

**Не искать причину в нагрузке от собственной сборки** — это объяснение проверено
и опровергнуто (`sar` в разгар падения: load average 0.25).

Что делать:

```bash
# 1. Проверить, доступен ли VPS прямо сейчас
curl -sS -o /dev/null -w '%{http_code}\n' --connect-timeout 10 https://dokploypanel.oplatishka.com/

# 2. Если доступен — просто перезапустить workflow, окно уже закрылось
gh workflow run deploy.yml --ref main

# 3. Если недоступен и с локальной машины — это авария VPS, а не CI:
#    проверить сайт и, если он тоже лежит, идти по runbooks/rollback.md
curl -sS -o /dev/null -w '%{http_code}\n' https://www.oplatishka.com/api/health
```

Ручной триггер тем же вызовом (см. контракт выше) остаётся рабочим обходом, но
после него **проверьте прод сами** — верификации из workflow в этом пути нет.

---

## Почему не встроенный GitHub App Dokploy

`autoDeploy` через App **дважды молча потерял событие мержа** (PR #102 и #103,
2026-07-25) — прод пересобирали руками. Та же история была с вебхуком Vercel
(PR #83, 2026-07-18, см. [`../incidents.md`](../incidents.md)).

**Установлено 2026-07-25** (раньше здесь стояло «различить нельзя»):

- **Доставки идут, но падают ВСЕ.** В журнале App (Settings → Developer settings →
  GitHub Apps → `dokploy-2026-04-26-j4eqtl` → Advanced → Recent Deliveries) каждое
  событие `push` и `pull_request` помечено ошибкой. То есть GitHub события шлёт —
  отвергает их Dokploy.
- **Дело не в доступе:** Repository access у установки — `All repositories`.
- **Дело не в сети:** `POST https://dokploypanel.oplatishka.com/api/deploy/github` отвечает
  извне `401 {"message":"Missing signature header"}` без подписи и
  `400 {"message":"Github Installation not found"}` с фиктивной.
- **У Dokploy всё на месте:** в его БД `githubWebhookSecret` длиной 40 символов,
  приватный ключ, `appId=3512126`, `installationId=127997942` — совпадает с App.

Остаётся расхождение на проверке подписи: поле **Webhook secret в самом App** либо
пустое (тогда GitHub не шлёт `X-Hub-Signature-256` и Dokploy отвечает 401), либо не
равно тому, что лежит в базе панели. Точный код виден в любой красной доставке,
вкладка Response.

**Проверено экспериментом:** коммит только в `docs/` (наш workflow пропускает его по
`paths-ignore`) запушен в `dev` в 15:52:53 UTC — Dokploy не создал деплой ни через
минуту, ни через две, при `autoDeploy: true` и корректной привязке. Событие в журнале
App за ту же секунду есть, и оно красное.

**Решение владельца 2026-07-25: не чинить.** Схема плоха независимо от бага —
**App деплоит сразу на push, не дожидаясь CI.** Красный `main` уехал бы на боевой
контур с живыми платежами, а провал сборки снова остался бы незамеченным. Если App
однажды починится сам, на каждый мерж пойдут две сборки: его — без гейта, наша —
после.

⚠️ **Чего делать НЕЛЬЗЯ, убирая App из схемы:** отвязывать git-провайдера
(`disconnectGitProvider`) и сужать Repository access. Dokploy клонирует репозиторий
при сборке по токену этой самой установки — без неё сломается и наш workflow-деплой.
Безопасный способ заглушить App — снять подписку на события `push`/`pull_request`
(Permissions & events → Subscribe to events), доступ к коду при этом сохраняется.

---

## API Dokploy: env, redeploy, состояние приложения

Панель закрыта basic-auth поверх собственного логина Dokploy, а порт 3000 наружу
закрыт firewall'ом. Отсюда два рабочих пути — оба **не требуют** открывать `/api`
наружу:

| Путь | Как | Когда |
|---|---|---|
| С самого VPS | `http://127.0.0.1:3000` + `x-api-key` | ssh уже открыт, basic-auth не участвует |
| Снаружи | `https://dokploypanel.oplatishka.com` + `x-api-key` **и** `Authorization: Basic` | из MCP или локальных скриптов |

⚠️ Только `x-api-key` снаружи не проходит: Traefik отвечает
`401 www-authenticate: Basic realm="Oplatishka panel"` ещё до Dokploy.

**MCP `@dokploy/mcp` подключён (2026-07-28)** в **local scope** — конфигурация
лежит в `~/.claude.json`, а НЕ в `.mcp.json` репозитория (он публичный).
Basic-auth проходится через `DOKPLOY_CUSTOM_HEADERS` с заголовком
`Authorization: Basic …`; именно это снимает возражение, из-за которого MCP убрали
27.07 — открывать `/api` наружу больше не нужно, оба барьера на месте.
Значения (`DOKPLOY_API_KEY`, пароль basic-auth) в репозиторий не попадают.

### id приложений

| Приложение | applicationId | Ветка |
|---|---|---|
| `oplatishka-web` (prod) | `7tTmVkOFbpmtP0vriH0oE` | `main` |
| `oplatishka-web-dev` | `yNIaENiQI2MX5adlDs2Yp` | `dev` |

### Правка env — порядок, проверенный на бою

```bash
# 1. прочитать приложение (API отдаёт env РАСШИФРОВАННЫМ)
curl -s -H "x-api-key: $DK_KEY" \
  'http://127.0.0.1:3000/api/application.one?applicationId=7tTmVkOFbpmtP0vriH0oE' -o app.json

# 2. БЭКАП env перед любой записью (у прода ~190 строк секретов)
python3 -c "import json;open('/root/env-backup.txt','w').write(json.load(open('app.json'))['env'])"
chmod 600 /root/env-backup.txt

# 3. изменить нужные строки, СОХРАНИВ остальные, и сохранить
curl -s -X POST -H "x-api-key: $DK_KEY" -H 'Content-Type: application/json' \
  --data @payload.json http://127.0.0.1:3000/api/application.saveEnvironment

# 4. применить (перезапуск с новым env)
curl -s -X POST -H "x-api-key: $DK_KEY" -H 'Content-Type: application/json' \
  -d '{"applicationId":"7tTmVkOFbpmtP0vriH0oE"}' http://127.0.0.1:3000/api/application.redeploy

# 5. проверить: startedAt обновился + значение реально доехало в контейнер
curl -s https://www.oplatishka.com/api/health
docker exec $(docker ps --filter name=oplatishka-web --format '{{.Names}}' | grep -v dev | head -1) \
  printenv | grep -E '^(PAYMENT_|FREEKASSA_)'
```

**Грабли, стоившие времени 2026-07-28:**

1. **`saveEnvironment` требует ещё `buildArgs`, `buildSecrets`, `createEnvFile`** —
   без них `400 Input validation failed`. Значения брать из `application.one`, а не
   выдумывать: в `buildArgs` у прода лежит Sentry DSN, и пустая строка убила бы
   клиентский Sentry на следующей сборке.
2. **В БД панели env хранится зашифрованным** (`enc:v1:…`) — «поправить SQL-запросом
   в обход API» не выйдет, даже имея доступ к `dokploy-postgres`.
3. **Payload перезаписывает env ЦЕЛИКОМ.** После записи обязательно сверить
   построчно: то же число ключей, ни один не пропал, изменились ровно те, что
   собирались (`diff` списков ключей + список изменённых строк).

## Ручные конфиги Traefik (вне Dokploy)

Часть маршрутизации живёт не в панели, а отдельными файлами в
`/etc/dokploy/traefik/dynamic/`. Dokploy генерирует свои per-app файлы
(`oplatishka-web-<suffix>.yml`) и перезаписывает их при каждом редеплое — поэтому
всё, что обязано пережить редеплой, вынесено в persistent-файлы, которых панель
не касается.

Исходники — в [`infra/traefik/`](../../infra/traefik/): шаблоны с плейсхолдером
имени swarm-сервиса, порядок установки описан в шапке каждого файла.

| Файл | Домен | Зачем |
|---|---|---|
| `oplatishka-www.yml` | www + apex | роутеры прод-домена, cert от внешнего lego (DNS-01), middleware `oplatishka-strip-altsvc` |
| `oplatishka-dev-webhook.yml` | dev | `/api/bot` без basic-auth (Telegram его не умеет) |
| `oplatishka-dev-miniapp.yml` | dev | `/cabinet` и зависимости без basic-auth (WebView его не умеет) |
| `oplatishka-admin.yml` | `admin.oplatishka.com` | домен админ-панели на тот же сервис `oplatishka-web` (отдельного приложения у панели НЕТ) |

⚠️ **При переезде на другой VPS они не переносятся ничем** — ни деплоем, ни
system backup Dokploy: тот несёт проекты, домены и env-переменные, но не
содержимое `dynamic/`. Ровно так при cutover 2026-07-24 потерялось снятие
`Alt-Svc`: Traefik снова стал рекламировать HTTP/3, браузеры на повторном заходе
пробовали QUIC, а ТСПУ режет его у мобильных операторов РФ — клиент ждал таймаута
на каждом заходе. Замечено по жалобе на скорость и восстановлено 2026-07-27.
**Раскладка этих файлов — обязательный пункт чек-листа переезда.**

Проверка после раскладки:

```bash
curl -sD - -o /dev/null https://www.oplatishka.com/ | grep -i alt-svc   # → alt-svc: clear
```

Правка применяется без рестарта Traefik (`providers.file.watch: true`), но битый
YAML он молча не применит — роутер исчезнет вместе с доменом. Поэтому
валидировать до подмены, а не после:

```bash
python3 -c "import yaml; yaml.safe_load(open('/tmp/new.yml'))" \
  && mv /tmp/new.yml /etc/dokploy/traefik/dynamic/oplatishka-www.yml
```

---

## Включение админ-панели на новом контуре

Панель не имеет своего приложения в Dokploy — она часть `oplatishka-web`. Чтобы
она заработала, нужны пять шагов, и **четвёртый молчит, если его забыть**.

1. **DNS**: A-запись `admin.<домен>` → IP VPS. Зона на Cloudflare, режим
   DNS-only (в браузере должен резолвиться НАШ IP, не прокси-адрес).
2. **Traefik**: положить `infra/traefik/oplatishka-admin.yml.example` в
   `/etc/dokploy/traefik/dynamic/oplatishka-admin.yml` и заменить
   `__WEB_SERVICE__` на реальное имя swarm-сервиса
   (`docker service ls | grep oplatishka-web`). Сертификат Let's Encrypt
   выпускается сам, проверять через минуту.
3. **Env** (порядок правки — в разделе «Правка env» выше, бэкап обязателен):
   `PANEL_HOST`, `ADMIN_SESSION_SECRET` (≥32 символа, `openssl rand -hex 32`),
   `TELEGRAM_LOGIN_BOT_TOKEN`, `TELEGRAM_LOGIN_BOT_USERNAME`,
   `TELEGRAM_LOGIN_BOT_WEBHOOK_SECRET` → редеплой.
4. **`/setdomain` у @BotFather** для бота персонала = домен панели.
   ⚠️ Без этого шага страница входа отдаёт ПУСТУЮ РАМКУ вместо кнопки, и
   причину не показывает ничто: скрипт виджета грузится (200), CSP пропускает,
   логи приложения и консоль браузера чисты. Диагноз только со стороны Telegram:

   ```bash
   curl -s "https://oauth.telegram.org/embed/<bot_username>?origin=https%3A%2F%2Fadmin.oplatishka.com" \
     | grep -o "Bot domain invalid"
   ```

   Метода Bot API для привязки нет — только вручную у @BotFather.
5. **Вебхук бота персонала** — `setWebhook` на
   `https://<ПУБЛИЧНЫЙ домен>/api/staff-bot` с тем же secret-token, что в env.
   На публичном домене намеренно: домен панели серверам Telegram не известен.
   `/api/admin/telegram-webhook` управляет ТОЛЬКО клиентским ботом.
6. **Сотрудник**: `pnpm --filter @oplati/db db:staff add <telegram_id> <email> admin <имя>`
   (с VPS либо SQL-эквивалентом — прод-БД снаружи недоступна). Секрет TOTP
   скрипт не выдаёт: его показывает панель при первом входе, РОВНО ОДИН раз.
   Сотрудник обязан один раз запустить бота персонала (`/start`), иначе
   уведомления не дойдут — Telegram отвечает 403 на DM от незапущенного бота.

Проверка после включения:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://admin.oplatishka.com/admin/login  # 200
curl -s -o /dev/null -w '%{http_code}\n' https://www.oplatishka.com/admin          # 404 — изоляция
```

⚠️ `ERR_NAME_NOT_RESOLVED` сразу после заведения DNS — это отрицательный кэш на
машине, а не проблема контура. Проверять `dig +short admin.oplatishka.com @8.8.8.8`
и авторитетным сервером зоны, лечить
`sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder` + очисткой
`chrome://net-internals/#dns`.

## ⚠️ Деплой НЕ применяет миграции БД

Пайплайн собирает образ и перезапускает сервис — и только. Если в мерже была
новая миграция, её надо применить отдельно, иначе получится «зелёный деплой при
живом `/api/health` и сломанной фиче»: ровно так 2026-07-28 Freekassa не смогла
выставить ни одного счёта (`freekassa_nonce` не существовал), см.
[`incidents.md`](../incidents.md).

**Когда применять — зависит от вида миграции:**

| Вид | Когда | Почему |
|---|---|---|
| ДОБАВЛЯЮЩАЯ (новая таблица, nullable-колонка) | **ДО выката кода** | старый образ о ней не знает и не пострадает, а новый без неё падает |
| УДАЛЯЮЩАЯ колонку | **ПОСЛЕ выката** | работающий образ спрашивает колонку явным списком (см. CLAUDE.md) |

Так катились 0039/0040 трека vcc-preflight: сначала на прод-БД и dev-БД, потом
мерж. ⚠️ В окне «миграция применена, мерж ещё не прошёл» `GET /api/ready` отдаёт
`503 migrations_ahead` — это ШТАТНО (БД впереди кода), но шаг «Проверить
готовность релиза» ветку `migrations_ahead` не разбирает и покрасит ЛЮБОЙ деплой
в этом окне, включая чужой PR и push в `dev`. Применяйте миграции тогда, когда
других мержей не планируется, либо ожидайте красный шаг.

**После деплоя проверять `/api/ready`, а не только `/api/health`:**

```bash
curl -s https://www.oplatishka.com/api/ready    # {"status":"ok"} — релиз готов
```

| Причина в ответе | Что значит |
|---|---|
| `migrations_pending` | код выкачен, миграции НЕ применены — применить немедленно |
| `migrations_ahead` | БД впереди кода: окно перед мержем или откат образа |
| `db_unreachable` | приложение не видит БД — проверить `DATABASE_URL` (имя сервиса Postgres меняется при пересоздании) |

Прод-БД снаружи недоступна, поэтому применение — с VPS:

```bash
# что уже применено на проде (последние записи журнала Drizzle)
ssh root@187.124.172.104 "docker exec \$(docker ps --filter name=oplatishka-db-ry3smb -q) \
  psql -U oplatishka -d oplatishka -t -A -c \
  'select count(*) from drizzle.__drizzle_migrations'"
# ⚠️ сверять ЧИСЛО применённых, а не только последние: пропуск в СЕРЕДИНЕ
# `limit 3` не покажет, а `/api/ready` его поймает (на 2026-08-25 их 41)

# hash в журнале = sha256 файла миграции — так и сверяют, чего не хватает
shasum -a 256 packages/db/migrations/00XX_*.sql

# применение: SQL через docker exec (см. CLAUDE.md), затем дописать журнал
# INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
#   VALUES ('<sha256 файла>', <when из meta/_journal.json>);
```

Запись в журнал обязательна: без неё следующий `db:migrate` попробует применить
миграцию повторно.

## Проверка после деплоя

```bash
# контейнер поднялся
ssh root@187.124.172.104 'docker ps --filter name=oplatishka-web-wwrt50 --format "{{.Status}}"'

# лог сборки
ssh root@187.124.172.104 'tail -5 "$(ls -t /etc/dokploy/logs/oplatishka-web-wwrt50/*.log | head -1)"'

# смоук
for u in / /api/health /cabinet /partner; do
  printf "%-14s %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' "https://www.oplatishka.com$u")"
done
```

Ожидаемо: контейнер `healthy`, в логе `✅ Docker build completed`, все пути `200`.

Проверить, что Sentry-DSN попал в билд (иначе клиентский Sentry и CSP-отчёты
мертвы — `NEXT_PUBLIC_*` инлайнится на сборке, в runtime-env бесполезен):

```bash
curl -sD - -o /dev/null https://www.oplatishka.com/ | grep -i 'report-uri.*sentry'
```

---

## Что нельзя проверить автоматически

Денежный путь e2e и телеграмные шаги (заказ → инвойс L&P → оплата → webhook →
выпуск карты → реквизиты в Telegram; `/start`, VPN, `/support`, привязка) — только
руками. Пошаговый чек-лист — в
[`../history/dokploy-cutover-report.md`](../history/dokploy-cutover-report.md),
раздел 12.


## Выкат помощника поддержки (трек support-ai)

Порядок — спека §13, сверен с тем, что реально сделано в коде:

1. **Миграция `0041_conscious_lilith`** — одна (не две: пара «enum отдельно + использование»
   падает у drizzle-мигратора, см. `CLAUDE.md` → «Расширение enum»). Применить на dev и прод
   **ДО выката кода**, а не после: миграция ДОБАВЛЯЕТ колонку `mode_expires_at`, и новый образ
   спрашивает её в каждом `select` из `conversations` (drizzle пишет явный список колонок) —
   выкати код первым, и до применения миграции падал бы каждый разговор: бот «забывает»
   историю, панель поддержки и `/api/chat` отвечают ошибкой. Старый код с новой схемой
   совместим: колонка nullable, прежние значения enum на месте, insert идёт без `handoff_mode`
   (дефолт `idle` старому коду безразличен). `/api/ready` на старом образе в окне отвечает
   `migrations_ahead` — это штатно, снаружи его никто не опрашивает.
2. **Ключ DeepSeek** — `SUPPORT_AI_API_KEY` в env обоих приложений Dokploy (один ключ на
   dev и prod). `SUPPORT_AI_BASE_URL`/`SUPPORT_AI_MODEL` не задавать — дефолты в коде.
3. **Смоук и eval** с ключом: `pnpm --filter @oplati/agent smoke:support` (сверить `model` в
   ответе — незнакомый id DeepSeek молча маппит на flash), затем `eval:support`; результаты —
   в Comments тикетов 02 и 08.
4. **`SUPPORT_AI_ENABLED=1` на dev** → нажать «Поддержка» в `@dev_test_podpiska_bot`,
   проверить приветствие, ответ, «Завершить», `/start`-сброс, эскалацию словом «оператор».
5. **Строка крона на VPS** — `support-housekeeping` из `infra/crontab.example` в
   `/etc/cron.d/oplatishka` (сдвиг `:07`, чтобы не совпадать с `expire-payments`).
6. **`SUPPORT_AI_ENABLED=1` на prod** + redeploy. Персонал должен один раз запустить бота
   входа — иначе пинги «без ответа» уйдут владельцу через `notifyOps`.

Откат — `SUPPORT_AI_ENABLED=0` + redeploy: кнопка снова ведёт в двухшаговый флоу к человеку,
миграцию откатывать не нужно (колонка и значение enum безвредны).
