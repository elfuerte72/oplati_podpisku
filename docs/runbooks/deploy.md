# Рунбук: деплой prod и dev

Контур — Dokploy на VPS `187.124.172.104`. Полная карта окружений (домены, БД, боты,
модели, какие ключи где) — в [`CLAUDE.md`](../../CLAUDE.md), раздел «Deployments».

---

## Как деплоится

**Единственный триггер — workflow [`Deploy`](../../.github/workflows/deploy.yml).**

```
push в main / dev
  → gate: pnpm typecheck + pnpm -r test + pnpm lint
  → POST https://dokploypanel.oplatishka.com/api/deploy/<refreshToken>   (до 10 попыток)
  → Dokploy собирает образ и подменяет контейнер
  → проверка: /api/health отдаёт startedAt позже момента триггера (только main)
  → провал любого шага → сообщение в Telegram
```

Шаг проверки нужен потому, что принятый триггер не равен выкаченному релизу:
раньше пайплайн заканчивался на «сборка запущена», и упавшая сборка давала
зелёный workflow при старом коде на проде.

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
