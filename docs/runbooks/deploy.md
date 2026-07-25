# Рунбук: деплой prod и dev

Контур — Dokploy на VPS `177.7.34.106`. Полная карта окружений (домены, БД, боты,
модели, какие ключи где) — в [`CLAUDE.md`](../../CLAUDE.md), раздел «Deployments».

---

## Как деплоится

**Единственный триггер — workflow [`Deploy`](../../.github/workflows/deploy.yml).**

```
push в main / dev
  → gate: pnpm typecheck + pnpm -r test + pnpm lint
  → POST https://dokploy.mxpkn8ns.ru/api/deploy/<refreshToken>   (до 10 попыток)
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

`main` защищён ruleset'ом: прямой push запрещён, только PR с зелёными
`Tests`/`Type Check`/`Lint`. Гейт внутри workflow — подстраховка на случай
`workflow_dispatch` и пушей в `dev`, у которого своего CI нет.

Ручной перезапуск без коммита: `gh workflow run deploy.yml --ref main`.

---

## Контракт deploy-вебхука Dokploy

**В документации Dokploy его нет** — снят перебором на живом контуре 2026-07-25.
Записан здесь, чтобы не выяснять второй раз.

```bash
curl -X POST "https://dokploy.mxpkn8ns.ru/api/deploy/<refreshToken>" \
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
curl -sS -o /dev/null -w '%{http_code}\n' --connect-timeout 10 https://dokploy.mxpkn8ns.ru/

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

Корневую причину со стороны репозитория установить нельзя: Dokploy→GitHub жив
(`testConnection` видит 14 репозиториев), эндпоинт доступен извне, очередь пуста,
логов у контейнера Dokploy нет. Остались два кандидата — GitHub не доставляет либо
Dokploy отвергает подпись — и различить их можно только в журнале доставок App:
GitHub → App `dokploy-2026-04-26-j4eqtl` → Advanced → Recent Deliveries.

Но починили заменой, а не отладкой, потому что схема была плохой независимо от
бага: **App деплоил сразу на push, не дожидаясь CI.** Красный `main` уехал бы на
боевой контур с живыми платежами без гейта, а отказы App не видны из репозитория.

---

## Проверка после деплоя

```bash
# контейнер поднялся
ssh root@177.7.34.106 'docker ps --filter name=oplatishka-web-wwrt50 --format "{{.Status}}"'

# лог сборки
ssh root@177.7.34.106 'tail -5 "$(ls -t /etc/dokploy/logs/oplatishka-web-wwrt50/*.log | head -1)"'

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
