# Мониторинг — куда смотреть, когда что-то не так

Шпаргалка по наблюдаемости проекта. Три слоя, каждый отвечает на свой вопрос.
Настроено 2026-07-23.

## TL;DR — что где смотреть

| Вопрос | Куда идти |
|---|---|
| «Сайт вообще открывается?» | Better Stack (uptime, алёрт в Telegram) |
| «Что за ошибка у клиента?» | Sentry |
| «Что происходило на прокси сайта / платежей?» | Grafana Loki (логи VPS) |
| «Что делало приложение (API, cron)?» | Vercel Dashboard → Logs + Sentry |
| «Прошла ли оплата, что с заказом?» | БД: таблицы `orders` / `order_events` / `payments` |

## Слой 1 — Uptime (жив ли узел, снаружи)

**Better Stack** (betterstack.com, free). Независимый сторож вне нашей инфраструктуры:
пингует узлы извне и шлёт алёрт в Telegram, если что-то легло.

Мониторы (создать в Better Stack → Monitors, интервал 3 мин):
- `https://www.oplatishka.com` — весь путь РФ-доступа (Timeweb-прокси + Vercel).
- `https://oplati-podpisku-web.vercel.app/api/health` — Vercel напрямую (отделяет
  «лёг прокси» от «лёг Vercel»).
- порт `177.7.34.106:24128` — squid-прокси платежей L&P (SPOF приёма денег).

Звонки в РФ у Better Stack не работают — алёрты только через Telegram-интеграцию
(Integrations → Telegram) и email.

## Слой 2 — Ошибки (что сломалось)

**Sentry** — уже настроен (PII-скраббер, алёрты в Telegram через
`/api/alerts/sentry`). Ловит исключения со ВСЕХ каналов: веб, бот, cron, платежи.
Первое место, куда смотреть при «что-то упало».

## Слой 3 — Логи (почему сломалось)

### VPS-прокси → Grafana Cloud Loki

Логи обоих VPS собирает агент **Alloy** (docker-контейнер `grafana-alloy`,
`--restart unless-stopped`, читает `docker.sock`, шлёт в Loki). Конфиг на каждом
VPS: `/opt/alloy/config.alloy`. Метка `node` различает серверы.

**Как смотреть:** [violetpasta1272.grafana.net/explore](https://violetpasta1272.grafana.net/explore)
1. Источник данных (выпадающий список вверху слева) → выбрать
   **`grafanacloud-violetpasta1272-logs`** (Loki), НЕ alert-state-history.
2. Режим **Code** (кнопка справа) → вписать запрос.

Полезные запросы (LogQL):
```
{node="timeweb-msk"}                                  # всё с прокси сайта (Timeweb)
{node="hostinger-lnp"}                                # всё с прокси платежей (Hostinger)
{node="timeweb-msk", container="oplatishka-proxy"}    # только Caddy-прокси сайта
{node="timeweb-msk", container="dokploy-traefik"}     # Traefik (TLS, роутинг, ACME)
{node="hostinger-lnp", container="lnp-proxy"}         # squid-прокси к L&P
{node="timeweb-msk"} |= "error"                       # только строки со словом error
{node="timeweb-msk", container="oplatishka-proxy"} | json | status >= `500`  # 5xx на прокси
```
Одна метка = один фильтр. Два `node=` разом дадут пусто (строка не может иметь
оба значения).

Caddy-прокси сайта пишет **access-log в JSON** (каждый запрос: статус, метод,
путь, реальный `client_ip`) — видно РФ-трафик поштучно.

**Тариф:** логи (Loki) — в бесплатном плане Grafana Cloud навсегда (50 ГБ/мес,
retention ~14 дней). Баннер «Trial» — это платные надстройки; после триала сбор
логов продолжит работать.

### Приложение (Vercel) → Vercel Dashboard + Sentry

Осознанно НЕ тащим в Loki (Vercel шлёт логи в своём формате, нужен конвертер =
лишний узел). Приложение и так видно: Vercel Dashboard → Logs (live + retention
на Pro) + Sentry (ошибки). Решение владельца 2026-07-23.

## Cron-джобы (следующий этап, опционально)

8 cron-джобов (`vercel.json`), их «тихая смерть» сейчас видна только по
последствиям. healthchecks.io (free): джоб в конце пингует URL, нет пинга по
расписанию → алёрт. Не реализовано.

## Доступ из сессии Claude

Read-токен Loki — в `.env` (`GRAFANA_LOKI_TOKEN`, user `1691092`, endpoint
`logs-prod-012.grafana.net`). Claude может запрашивать логи любого узла через
Loki API для анализа. Write-токен агентов — `GRAFANA_LOKI_WRITE_TOKEN`.
