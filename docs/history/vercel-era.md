# Эпоха Vercel и реверс-прокси РФ-доступа (архив)

⚠️ **Это история, а не ТЗ.** Контура, описанного здесь, больше нет. С 2026-07-27 весь проект
живёт на одном VPS Hostinger `187.124.172.104` (Франкфурт) под Dokploy: приложение, обе БД,
Redis, cron. Ни Vercel, ни реверс-прокси Timeweb в схеме не участвуют.

Файл выделен из `CLAUDE.md` 2026-08-14: оба раздела пережили переезд нетронутыми и описывали
несуществующую инфраструктуру как действующую — а `CLAUDE.md` читается агентом как правда о
сегодняшнем дне.

**Проверено на живом проде 2026-08-14:**

| Что | Тогда | Сейчас |
|---|---|---|
| `www.oplatishka.com` | A-запись на Timeweb `104.171.133.70` | `187.124.172.104` (Hostinger, Франкфурт) |
| Путь клиента | клиент → Traefik Timeweb → Caddy → Vercel | клиент → Traefik на нашем VPS → контейнер |
| `CLIENT_IP_MODE` | `vercel` (дефолт той эпохи) | `traefik` |
| `PROXY_SHARED_SECRET` | задан в Vercel Production+Preview | **не задан** — ветка `X-Client-IP` мертва |
| `MINIAPP_BASE_URL` | `oplati-podpisku-web.vercel.app/cabinet` | **не задан** — кабинет резолвится от `APP_URL` |

✅ **Прокси больше не нужен — проверено живьём.** Владелец подтвердил 2026-08-14: сайт
открывается из России без VPN напрямую с Hostinger. То есть проблема была именно в
IP-диапазонах Vercel, а не в зарубежном хостинге как таковом: франкфуртский адрес ТСПУ не
трогает. Возвращать реверс-прокси имеет смысл, только если РФ-доступ сломается снова.

Код до сих пор умеет обе мёртвые ветки (`CLIENT_IP_MODE='vercel'`, `X-Client-IP` +
`PROXY_SHARED_SECRET`, `VERCEL_URL` в `deployment-url.ts`) — они не удалены, а обесточены
отсутствием env. Разбор, удалять ли их, — в [`docs/BACKLOG.md`](../BACKLOG.md).

Первый переезд (Vercel → Dokploy, 2026-07-24) описан в
[`dokploy-cutover-report.md`](dokploy-cutover-report.md); второй (Бостон → Франкфурт,
2026-07-27) — в [`../runbooks/server-migration.md`](../runbooks/server-migration.md).

---

## Как было на Vercel

Vercel `fra1`. Два окружения с **раздельными Telegram-ботами** (webhook у бота один → шарить нельзя):

- **Production** — `https://www.oplatishka.com` (custom-домен подключён 2026-07-03; env `APP_URL` указывает на него — от него резолвятся mini app `/cabinet`, кнопка «Сайт», презентация партнёрки, payment deep-link, self-call). Дефолтный `oplati-podpisku-web.vercel.app` тоже обслуживает (старые ссылки не ломаются). Бот `@oplatishkaa_bot` (переезд 2026-07-03 со старого `@test_prodipsa_bot` — смена токена в env; username везде резолвится через `getMe`, код не менялся; у старого бота вебхук снят, клиенты должны нажать Start у нового, иначе бот не может писать первым). Auto-deploy на merge в `main`.
- **Preview** — branch-alias `oplati-podpisku-web-git-<branch>-<team>.vercel.app` на каждый push в feature-ветку. Бот `@dev_test_podpiska_bot`. Перед merge — smoke-тест через dev-бота: webhook перерегистрируется на новый preview-URL. **Preview изолирован от прод-данных (F-01) и с 2026-07-18 подключён к отдельной dev-Supabase** `oqwofyipeuzgezdplixn` (лежит в ДРУГОМ Supabase-аккаунте, чем прод, — free-план старого органа исчерпан; claude.ai Supabase MCP видит только прод-орг). Vercel Preview env: `DATABASE_URL`/`DATABASE_URL_DIRECT`/`SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` — dev-значения (записи `SUPABASE_URL`/`ANON_KEY` разделены по окружениям, раньше были общими с продом), `APP_URL` — fallback `oplati-podpisku-web.vercel.app` (код на preview использует `VERCEL_URL`; без APP_URL env-схема роняла деплой), `AI_DAILY_TOKEN_BUDGET=200000` — предохранитель AI-расходов, отдельный `CRON_SECRET` (Vercel Cron на preview не бегает, но cron-endpoints можно дёргать руками), `ANTHROPIC_API_KEY` (прод-ключ) + `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` — **основной агент на Preview/локально работает на Haiku** (дешевле; прод остаётся `claude-sonnet-4-6`, записи разделены по окружениям). Миграции/seed на dev-БД гоняются локально: в корневом `.env` — `DEV_DATABASE_URL`, `DEV_DATABASE_URL_DIRECT`, `DEV_SUPABASE_SERVICE_ROLE_KEY`, `DEV_CRON_SECRET`; запуск — `DATABASE_URL_DIRECT="$DEV_DATABASE_URL_DIRECT" DATABASE_URL=... pnpm --filter @oplati/db db:migrate` (shell-env имеет приоритет над `--env-file`). Локальная разработка (`pnpm dev`) тоже должна ходить в dev-БД, не в прод. Пайплайн: feature-ветка → push → Preview (dev-БД + dev-бот, smoke) → PR → CI (tests/typecheck/lint) → squash в `main` → прод. **Main защищён ruleset'ом `protectionOplatishka` (2026-07-18):** прямой push запрещён — только PR с зелёными required-чеками `Tests`/`Type Check`/`Lint` (approvals 0 — solo, сам себе аппрув GitHub не даёт); force-push и удаление ветки заблокированы. **После каждого мержа в `main` проверять, что Vercel создал Production-деплой** (`vercel ls` или дашборд): 2026-07-18 GitHub→Vercel вебхук потерял событие мержа PR #83 и прод деплоили вручную `vercel deploy --prod` (см. [`../incidents.md`](../incidents.md)). НЕ возвращать прод-секреты в Preview.

**Vercel Deployment Protection: Disabled** — иначе Telegram получает `401` от обвязки Vercel до нашего кода. Защита — secret-token (`/api/bot`), подпись (L&P webhook), `X-Internal-Token` (внутренние endpoints), Supabase RLS.

**Telegram-секреты той эпохи:** токены лежали в Vercel env с флагом `Sensitive` (`vercel env pull` отдавал пустую строку — by design; аудит по бейджу «Updated» в UI). После смены секрета требовался redeploy — старые деплои держали стейл значение и отвечали `401`.

## Доступ сайта из РФ без VPN — реверс-прокси на российском VPS (2026-07-22 … 2026-07-27)

РКН/ТСПУ блокирует IP-диапазоны Vercel и дросселирует Cloudflare у мобильных операторов РФ (h3/ECH + обрыв соединения после ~16 КБ) — `oplatishka.com` без VPN не открывался. Проверено живьём: Cloudflare-проксирование (оранжевое облако + off ECH/HTTP3) **не помогло** для Мегафона — CF сам под дросселем. Рабочее решение — **reverse-proxy через российский VPS** (Timeweb, Москва, `104.171.133.70`, пинг 1–3 мс из РФ): для пользователя это обычный РФ-сайт, ТСПУ его не трогает.

**Статус на 2026-07-22 (владелец подтвердил доступ из РФ без VPN со стилями).** `www.oplatishka.com` и `oplatishka.com` — CF DNS → A-запись на Timeweb `104.171.133.70` (серое облако, DNS only; NS домена = Cloudflare). Цепочка на Timeweb (Dokploy/Traefik, overlay swarm): `клиент → Traefik (443, TLS/ACME Let's Encrypt) → Caddy-sidecar oplatishka-proxy → Vercel`. Конфиги на VPS (не через Dokploy UI): `/etc/dokploy/traefik/dynamic/oplatishka.yml` (роутеры www/apex/beta + middleware `oplatishka-strip-altsvc`) + `/opt/oplatishka-proxy/Caddyfile`. `beta.oplatishka.com` оставлен как тестовый алиас. Оферта Timeweb Cloud (VPS) reverse-proxy собственного сайта не запрещает (в отличие от их же виртуального хостинга); домен не в реестрах РКН.

**Три подводных камня перевода:**
1. **Vercel Firewall System Mitigations** включил bot-challenge (`x-vercel-mitigated: challenge`, 403) на весь домен — весь трафик идёт с одного IP (Timeweb) и выглядит как атака. Решение: **Timeweb IP в System Bypass** (`vercel firewall system-bypass add 104.171.133.70 --yes`) — обязательная часть схемы, без неё прокси душится. Attack Mode при этом Off (challenge — от авто-митигаций).
2. **Caddy connection-pool SNI-mismatch:** при разных SNI на общий upstream `cname.vercel-dns.com` Caddy переиспользует TLS-соединение с чужим SNI → Vercel отдаёт плавающие 403. Решение — **единый Host/SNI = `www.oplatishka.com`** для всех доменов в Caddyfile (apex видит www-контент без 308 — приемлемо).
3. **Alt-Svc (HTTP/3):** Traefik рекламировал h3 → браузер на повторном заходе пробует QUIC, который ТСПУ режет. Снято middleware `oplatishka-strip-altsvc` (customResponseHeaders `Alt-Svc: ""`) на наших роутерах.

**Клиентский IP за прокси.** Эмпирически: Vercel затирал `x-real-ip`/`x-forwarded-for` IP-адресом соединения (= IP прокси), поэтому per-IP лимит схлопнул бы всех в один IP. Caddy клал реальный IP клиента в `X-Client-IP` (через `{client_ip}` c `trusted_proxies`) + секрет в `X-Proxy-Secret`; `getClientIp` читал `X-Client-IP` только при совпадении секрета `PROXY_SHARED_SECRET`.

**Mini App-кабинет — НАПРЯМУЮ на Vercel, мимо прокси.** Кабинет открывается только из Telegram (у РФ-пользователя VPN уже есть → `*.vercel.app` доступен), поэтому прокси ему не нужен, а лишний хоп РФ→Vercel лишь добавлял задержку. `miniAppUrl()` на production вёл на `MINIAPP_BASE_URL` (`oplati-podpisku-web.vercel.app/cabinet`), `siteUrl()` оставался на `APP_URL` (www) за прокси. Второй вход — Direct Link в @BotFather.

**Денежный/ботовый путь был изолирован от прокси:** self-call `payments/create` шёл через `VERCEL_URL` (собственный хост деплоя, мимо www). Исходящие запросы В L&P шли через squid на `187.124.172.104` (удалён 2026-07-25). Смоук после перевода: заказ ORD-S3MGS создан чисто (order_created → payment_invoice_created, суммы консистентны).

**Наследство, которое пережило переезд и остаётся актуальным:** WAF-правила у Vercel-проекта
`block-payments-after-dokploy-migration` (deny на `/api/payments/*`) и
`block-cron-after-dokploy-migration` — страховка от того, что погашенный деплой примет вебхук
или запустит cron. Вебхук L&P в кабинете провайдера — один, на
`https://www.oplatishka.com/api/payments/loveandpay`.
