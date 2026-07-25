# Рунбук: откат и гашение резерва

Прод живёт на Dokploy/VPS с 2026-07-24. Vercel + Supabase остались **холодным
резервом**. Здесь: как откатиться, если Dokploy станет неработоспособен, и в каком
порядке гасить резерв, когда он больше не нужен.

---

## Уровень 1: откатить код, оставшись на Dokploy

Самое частое и самое дешёвое. Плохой релиз откатывается предыдущим образом:

- Dokploy → `oplatishka-web` → Deployments → у нужной сборки **Rollback**;
- либо revert-коммит в `main` через PR — workflow `Deploy` соберёт заново.

Второй путь честнее (история кода совпадает с тем, что в проде), но медленнее на
время сборки.

---

## Уровень 2: полный откат на Vercel + Supabase

⚠️ **Данные в Supabase — на момент cutover 2026-07-24.** Всё, что клиенты сделали
после, живёт только в Postgres на VPS. Откат = потеря этих заказов и платежей,
если не перенести их вручную. Поэтому уровень 2 — только если VPS недоступен как
таковой, и сначала пытаться снять с него дамп.

Порядок (обратный тому, чем гасили Vercel):

1. **Вернуть домены в Vercel-проект.** Сейчас сняты: Vercel отдаёт
   `404 DEPLOYMENT_NOT_FOUND` на `Host: www.oplatishka.com`.
   `vercel domains add oplatishka.com` + привязать к проекту `oplati-podpisku-web`.
2. **Снять WAF-правило, гасящее кроны:**
   ```bash
   vercel firewall rules remove block-cron-after-dokploy-migration
   vercel firewall publish --yes
   ```
   Без этого Vercel Cron продолжит получать `deny` на `/api/cron/*`.
3. **Вернуть Git-связь**, если нужен автодеплой: `vercel git connect`.
   Не обязательно для обслуживания — текущий прод-деплой Vercel готов и жив.
3a. ⚠️ **Поднять обратно squid-прокси к Love&Pay** — иначе платежи не заработают:
   у Vercel исходящий IP динамический, а L&P пускает только задекларированный,
   и все запросы получат `403 SOURCE_IP_NOT_ALLOWED`. Контейнер удалён
   2026-07-25, конфиг цел:
   ```bash
   ssh root@177.7.34.106 'bash /opt/lnp-proxy/run.sh'   # поднимает squid на :24128
   ```
   затем задать `LOVEANDPAY_PROXY_URL` в env Vercel (значение — в
   `/opt/lnp-proxy/proxy-url` на VPS) и передеплоить: без redeploy старые
   функции переменную не увидят.
4. **Вернуть блок `crons` в `apps/web/vercel.json`** (снят при переезде) и
   задеплоить: расписания живут в crontab VPS, на Vercel их больше нет.
5. **DNS:** Cloudflare `www` и apex → на Vercel. Прямо на Vercel из РФ **не
   откроется** (РКН блокирует их IP) — нужен реверс-прокси Timeweb
   (`104.171.133.70`), конфиги там сохранены:
   `/etc/dokploy/traefik/dynamic/oplatishka.yml` и `/opt/oplatishka-proxy/Caddyfile`.
   Плюс вернуть Timeweb-IP в Vercel System Bypass:
   `vercel firewall system-bypass add 104.171.133.70 --yes` — без него Vercel душит
   весь трафик с одного IP bot-challenge'ем.
6. **Webhook бота** → на Vercel-хост (`POST /api/admin/telegram-webhook` с
   `X-Internal-Token`), **webhook L&P** → в кабинете L&P на
   `oplati-podpisku-web.vercel.app`.
7. **Остановить cron на VPS**, иначе два парка кронов будут работать по двум БД:
   `rm /etc/cron.d/oplatishka`. Это ровно тот split-brain, который ловили
   2026-07-25: at-most-once (атомарный claim `paid → in_fulfillment`) локален для
   ОДНОЙ базы, поэтому один инвойс обработали бы дважды — две карты PaySpace, два
   DM клиенту, два реферальных начисления.

---

## Уровень 3: восстановление БД из бэкапа

Отдельная процедура — [`backup-restore.md`](backup-restore.md).

---

## Порядок гашения резерва

Гасить **только по явному решению владельца** и по одному, с паузой: каждый шаг
уменьшает пути отката.

| Что | Когда можно | Как |
|---|---|---|
| **Upstash** (старый rate-limit) | сразу — заменён self-host Redis+SRH, в env прода не фигурирует | отключить в дашборде |
| ~~**squid-прокси** `177.7.34.106:24128`~~ | **удалён 2026-07-25** — приложение выходит в L&P напрямую с того же IP (проверено: их API отвечает `401 MISSING_HEADERS`, не `403 SOURCE_IP_NOT_ALLOWED`) | конфиг оставлен в `/opt/lnp-proxy/`, поднять обратно: `bash /opt/lnp-proxy/run.sh` |
| **Timeweb-VPS** `104.171.133.70` | после 1–2 недель стабильности | снять конфиги `oplatishka.yml` + `Caddyfile`, DNS `beta.oplatishka.com`. **Не трогать другие проекты на том VPS** |
| **Vercel-проект** | после 1–2 недель | автодеплой и домены уже сняты; удалять деплой/проект — последним шагом |
| **Supabase-прод** `nyxijwpuvctmvemaemqn` | **не раньше месяца** | страховка данных; перед удалением снять финальный дамп |

Перед гашением Supabase — сверить, что в Dokploy-Postgres данные не хуже: счётчики
и суммы по чек-листу из [`backup-restore.md`](backup-restore.md).

⚠️ Supabase **уже не заморожен**: после cutover туда продолжал писать живой
Vercel-деплой (таблица `link_tokens` росла), пока 2026-07-25 не отключили
автодеплой и не погасили кроны. Клиентских `orders`/`payments` там с 2026-07-22 не
прибавилось, но считать её точным снимком момента cutover нельзя.

---

## Что проверить после любого откатa

Смоук из [`deploy.md`](deploy.md) плюс:

- `getWebhookInfo` бота показывает ожидаемый хост и `pending_update_count 0`;
- ровно **один** парк cron-джобов активен;
- денежный путь: тестовый заказ до выставления счёта (не оплачивать) — что
  `payments/create` отвечает ссылкой, а не `503 provider_unavailable`.
