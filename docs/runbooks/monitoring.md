# Мониторинг — куда смотреть, когда что-то не так

Единая точка наблюдаемости — **Grafana Cloud** (стек `violetpasta1272`): логи всех
узлов, внешний uptime и алёрты в Telegram. Плюс Sentry (ошибки приложения).
Настроено 2026-07-23.

## TL;DR — что где смотреть

| Вопрос | Куда идти |
|---|---|
| «Сайт открывается?» | Grafana → алёрт «Сайт недоступен» прилетит в Telegram |
| «Что за ошибка у клиента?» | Sentry |
| «Что происходило на прокси сайта / платежей?» | Grafana → дашборд «Оплатишка — узлы» |
| «Что делало приложение (API, cron)?» | Vercel Dashboard → Logs + Sentry |
| «Прошла ли оплата, что с заказом?» | БД: `orders` / `order_events` / `payments` |

Дашборд узлов: **[violetpasta1272.grafana.net/d/oplatishka-nodes](https://violetpasta1272.grafana.net/d/oplatishka-nodes)**
— сверху выпадающие списки **Узел** / **Контейнер** / **Поиск** (кнопками, без
ручного LogQL).

## Алёрты (в Telegram через dev-бота @dev_test_podpiska_bot)

Grafana шлёт уведомления на chat id владельца (`379336096`). Настроенные правила
(папка «Оплатишка — алёрты»):

| Алёрт | Когда срабатывает | Severity |
|---|---|---|
| **Сайт недоступен (внешний пинг)** | www.oplatishka.com не отвечает 200 из Frankfurt И London 2+ мин | critical |
| **Прокси сайта: ошибки 5xx** | oplatishka-proxy отдаёт >10 ошибок 5xx за 5 мин | warning |

## Слой 1 — Uptime (жив ли сайт снаружи)

**Grafana Synthetic Monitoring** (входит в Grafana Cloud): робот пингует
`https://www.oplatishka.com` каждые 60 с из **Frankfurt (14)** и **London (1)**,
проверяет статус 200 + валидный SSL. Метрика `probe_success{job="oplatishka-site"}`
(1 = жив, 0 = лёг). Check id `85330`. Управление —
Grafana → Synthetic Monitoring, или SM API
`synthetic-monitoring-api-eu-west-2.grafana.net`.

Ловит «сайт недоступен пользователю» по любой причине (лёг Timeweb-прокси, лёг
Vercel, сеть). Better Stack НЕ используется — у него нет Telegram-канала.

## Слой 2 — Ошибки (что сломалось)

**Sentry** — настроен ранее (PII-скраббер, алёрты в Telegram через
`/api/alerts/sentry`). Ловит исключения со всех каналов: веб, бот, cron, платежи.

## Слой 3 — Логи (почему сломалось)

### VPS-прокси → Grafana Loki

Агент **Alloy** (docker `grafana-alloy`, `--restart unless-stopped`, читает
`docker.sock`) на обоих VPS шлёт логи в Loki. Конфиг: `/opt/alloy/config.alloy`.
**Собираются ТОЛЬКО наши контейнеры** (keep-фильтр по имени — чужие сайты
владельца на том же VPS не попадают): Timeweb — `oplatishka-proxy`,
`dokploy-traefik`; Hostinger — `lnp-proxy`. Метка `node` различает серверы.

**Как смотреть:** дашборд (ссылка выше) или
[explore](https://violetpasta1272.grafana.net/explore) → источник
`grafanacloud-violetpasta1272-logs` (Loki) → режим **Code**:
```
{node="timeweb-msk"}                                  # прокси сайта (Timeweb)
{node="hostinger-lnp"}                                # прокси платежей (Hostinger)
{node="timeweb-msk", container="oplatishka-proxy"}    # только Caddy-прокси сайта
{node="timeweb-msk", container="dokploy-traefik"}     # Traefik (TLS, роутинг, ACME)
{node="timeweb-msk"} |= "error"                       # только строки с error
{node="timeweb-msk", container="oplatishka-proxy"} | json | status>=`500`  # 5xx
```
Один фильтр `node` за раз (два `node=` разом → пусто). Caddy-прокси пишет
access-log в JSON (каждый запрос: статус/метод/путь/реальный `client_ip`).

**Тариф:** логи (Loki) и Synthetic Monitoring — в бесплатном плане Grafana Cloud
навсегда (50 ГБ логов/мес, лимит SM-проверок). Баннер «Trial» = платные
надстройки; после триала логи и uptime продолжат работать.

### Приложение (Vercel) → Vercel Dashboard + Sentry

Осознанно НЕ тащим в Loki (Vercel шлёт логи в своём формате, нужен конвертер =
лишний узел). Приложение видно: Vercel Dashboard → Logs (Pro-retention) + Sentry.
Решение владельца 2026-07-23.

## Cron-джобы (следующий этап, опционально)

8 cron-джобов (`vercel.json`), «тихая смерть» видна по последствиям.
healthchecks.io (free): джоб в конце пингует URL, нет пинга → алёрт. Не сделано.

## Токены и доступ (в `.env`, gitignored)

| Env | Что |
|---|---|
| `GRAFANA_LOKI_TOKEN` | read Loki — Claude читает логи узлов из сессии для анализа |
| `GRAFANA_LOKI_WRITE_TOKEN` | write Loki — агенты Alloy (в конфиге на VPS) |
| `GRAFANA_SA_TOKEN` | service account admin — Claude настраивает дашборды/алёрты |
| `ALERT_BOT_TOKEN` | dev-бот @dev_test_podpiska_bot — канал алёртов Grafana |
| `ALERT_CHAT_ID` | `379336096` — куда шлём алёрты |

SM access token и Prometheus push — служебные, получаются из Grafana API.
