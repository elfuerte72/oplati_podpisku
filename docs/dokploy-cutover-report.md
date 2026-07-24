# Переезд Vercel + Supabase → Dokploy/VPS: отчёт, верификация, код-ревью, чистка

> **Дата переезда:** 2026-07-24. Cutover прошёл с нулевым downtime.
> **Этот файл — рабочее ТЗ для следующей сессии.** Задача агента: провести полную
> верификацию, smoke-тесты, полноценный код-ревью, найти и убрать остатки Vercel,
> удалить мёртвый код. Ставь статусы чекбоксами по мере выполнения (`[ ]`→`[x]`).
> НЕ удаляй Vercel-проект / Timeweb / Supabase до явного разрешения владельца
> (они — холодный резерв на 1–2 недели / месяц).

---

## 1. Что было и что стало

| | Было (до 2026-07-24) | Стало |
|---|---|---|
| Хостинг приложения | Vercel (`fra1`) | **Dokploy на Hostinger VPS** `177.7.34.106` (US Boston) |
| РФ-доступ | Vercel заблокирован РКН → reverse-proxy Timeweb (Москва) перед Vercel | VPS **сам доступен из РФ** без VPN (напрямую) |
| База данных | Supabase (managed Postgres) | **self-hosted Postgres 17** в Dokploy (чистый Postgres, НЕ Supabase-стек) |
| Rate-limit backend | Upstash (managed) | **self-hosted Redis + SRH** (serverless-redis-http, Upstash-совместимый REST) |
| Cron | Vercel Cron (`vercel.json`) | **системный crontab** на VPS (`/etc/cron.d/oplatishka`, 7 джобов) |
| TLS | Vercel авто | **Let's Encrypt через lego DNS-01** (Cloudflare); cert-renewal cron вс 04:00 |
| Egress к L&P | squid-прокси (фикс. IP под allowlist) | напрямую (VPS IP `177.7.34.106` = задекларированный) |

**Почему переехали:** VPS доступен из РФ без VPN (в отличие от Vercel), уход от вендоров,
консолидация, обучение self-host. Timeweb-прокси был костылём под Vercel — больше не нужен.

---

## 2. Новая архитектура (реестр компонентов)

**Dokploy проект `oplatishka`** (projectId `OnlfWzDFSodD634jazwsW`, панель `dokploy.mxpkn8ns.ru`):

| Сервис | appName / host | Что |
|---|---|---|
| `oplatishka-web` | `oplatishka-web-wwrt50` (appId `7tTmVkOFbpmtP0vriH0oE`) | **ПРОД** Next.js, ветка `main`, Sonnet, autoDeploy on push |
| `oplatishka-db` | `oplatishka-db-ry3smb` (id `0k6ld4xxCXDPgEtrpMGvq`) | ПРОД Postgres 17 (данные) |
| `oplatishka-redis` | `oplatishka-redis-djvpva` | rate-limit backend (redis:7.4.9) |
| `oplatishka-srh` | `oplatishka-srh-hv8tmh` | Upstash-совместимый REST (serverless-redis-http:0.0.10) |
| `oplatishka-web-dev` | `oplatishka-web-dev-d2nrxq` (appId `yNIaENiQI2MX5adlDs2Yp`) | **DEV-стенд** `dev.oplatishka.com`, ветка `dev`, за Basic Auth |
| `oplatishka-db-dev` | `oplatishka-db-dev-kqreaj` (id `POhRqcXehD1X5KFl5g_Lc`) | dev Postgres (структура = prod, без клиентских данных) |

**Домены (Cloudflare DNS, zone `708c06b8eda03217eb6947d19bacab51`, все DNS-only/серое облако):**
- `www.oplatishka.com` + `oplatishka.com` → `177.7.34.106` — прод (сайт, кабинет, L&P webhook)
- `new.oplatishka.com` → `177.7.34.106` — тот же prod-контейнер (сейчас на нём бот-webhook)
- `dev.oplatishka.com` → `177.7.34.106` — dev-стенд (Basic Auth: логин `dev`)

**Traefik (глобальный, Dokploy):** httpChallenge `letsencrypt` для остальных проектов НЕ тронут.
Наши www/apex — через **отдельный** persistent dynamic-файл
`/etc/dokploy/traefik/dynamic/oplatishka-www.yml` (cert от lego, `tls.certificates`, БЕЗ certResolver).
Бот-webhook `/api/bot` на dev — публичное исключение `oplatishka-dev-webhook.yml`.

**Cert:** lego (`/opt/lego-oplatishka/`), cron renewal `/etc/cron.d/lego-oplatishka-renew` (вс 04:00).
**Cron джобы:** `/etc/cron.d/oplatishka` (7 шт, замена Vercel Cron; без `keepalive`).
**Бэкапы:** нативный Dokploy backup `oplatishka-db` → Cloudflare R2 `dokploy-backups`, 03:00 UTC, keep 14.
**Секреты контура (НЕ в git):** локальный `.env.dokploy-test.local` (все Dokploy-пароли/токены с префиксами `DOKPLOY_`/`DEV_`/`PROD_`).

---

## 3. Как убедиться, что ВСЁ на Dokploy (верификация)

- [ ] **3.1 Резолв доменов** (уже проверено 2026-07-24): www/apex/new → `177.7.34.106`.
      Проверить: `curl -s "https://cloudflare-dns.com/dns-query?name=www.oplatishka.com&type=A" -H "accept: application/dns-json"`.
- [ ] **3.2 Webhook'и** (проверено): бот → `new.oplatishka.com/api/bot` ip `177.7.34.106`;
      L&P → `www.oplatishka.com/api/payments/loveandpay`. `getWebhookInfo` ip должен быть VPS.
- [ ] **3.3 Vercel не получает клиентского трафика.** Проверить через Vercel dashboard →
      Analytics / Runtime Logs: клиентских запросов ≈ 0 (только боты/preview). Либо `vercel logs`.
- [ ] **3.4 Тест «пауза Vercel»** (по желанию, 100%-доказательство): в Vercel Settings → Domains
      временно снять `www.oplatishka.com` + `oplatishka.com` (они уже не резолвятся на Vercel,
      привязка косметическая) ИЛИ отключить Git-автодеплой (Settings → Git). Если сайт/бот/платежи
      продолжают работать — всё на Dokploy. **Полностью деплой Vercel НЕ удалять** (резерв).
      Примечание: у Vercel нет кнопки «pause project»; ближайшее — отключить автодеплой и/или
      снять домены. Реальную остановку обслуживания даёт только удаление деплоя — НЕ делать сейчас.
- [ ] **3.5 Данные синхронны** (проверено: Dokploy = Supabase, orders 133 / messages 826 /
      conv 131 / payments 46). Перепроверить перед удалением Supabase.

---

## 4. Smoke-тесты (полный клиентский путь на новом проде)

Выполнять на боевом `@oplatishkaa_bot` + `www.oplatishka.com`. ⚠️ живой прод — тестовые
заказы создают реальные инвойсы L&P; оплачивать минимальной суммой или отменять.

- [ ] **4.1 Сайт из РФ без VPN** (владелец, мобильный): `www.oplatishka.com` открывается,
      каталог, «Как это работает», карточка сервиса, кнопка оплаты с суммой.
- [ ] **4.2 Бот `/start`**: GREETING + inline-меню (Открыть приложение / Сайт / Поддержка /
      Telegram-канал / VPN).
- [ ] **4.3 VPN-кнопка** (`REMNAWAVE_API_TOKEN` задан): выдаёт ссылку-подписку, «Обновить ссылку».
- [ ] **4.4 `/support`**: двухшаговый флоу → обращение доходит оператору (`SUPPORT_OPERATOR_CHAT_ID=379336096`).
- [ ] **4.5 Привязка веб↔Telegram**: интро/профиль → deep-link → бот `/start link_*` → статус привязки.
- [ ] **4.6 Заказ e2e**: каталог → propose (цена = курс×USD + 30% + $4 issue-fee) → confirm →
      инвойс L&P (напрямую, без squid) → оплата → **webhook L&P → paid** → `issue-card` (PaySpace) →
      реквизиты карты в Telegram → `completed`. Проверить и **poll-payment** как fallback.
- [ ] **4.7 Кабинет (Mini App)**: `www.oplatishka.com/cabinet` — каталог, экран карты (live-баланс
      PaySpace), реф-ссылка, партнёрка.
- [ ] **4.8 Рефералка** (`REFERRAL_ENABLED=1`): реф-ссылка, захват реферера, начисление при оплате.
- [ ] **4.9 Cron**: все 7 джобов отработали по расписанию — проверить в Grafana Loki (alloy
      собирает логи контейнера) + `grep CRON /var/log/syslog` на VPS. Ручной вызов:
      `curl -H "Authorization: Bearer $CRON_SECRET" https://www.oplatishka.com/api/cron/poll-payment`.
- [ ] **4.10 Rate-limit**: ротация поддельных `x-real-ip`/`x-forwarded-for` НЕ обходит лимит
      (self-host Redis + `CLIENT_IP_MODE=traefik`).
- [ ] **4.11 Sentry**: ошибки долетают (`environment=production`, DSN через `NEXT_PUBLIC_SENTRY_DSN`).
- [ ] **4.12 Алёрты**: `@oplatishkaAlert_bot` (`ALERT_TELEGRAM_CHAT_ID=379336096`) — proxy-health/недоплаты.

---

## 5. Полноценный код-ревью (запустить `/full-review` или вручную по осям)

- [ ] **5.1 Запустить `/full-review`** (skill проекта) на текущем состоянии `main` — оси:
      БД-инварианты, платежи/идемпотентность, безопасность/PII/RLS, границы пакетов, корректность.
- [ ] **5.2 Проверить инварианты CLAUDE.md** не нарушены переездом: `order_events` append-only,
      идемпотентность webhook (`claimPaymentSucceeded`), деньги-integer, `transitionOrder`,
      Zod на границах, webhook 200 OK, RLS.
- [ ] **5.3 Проверить, что self-host не сломал контракты**: L&P (подпись webhook на новом секрете),
      PaySpace (выпуск карт), Rapira (курс), Remnawave (VPN), Anthropic (Sonnet).
- [ ] **5.4 `pnpm typecheck` + `pnpm --filter web test` + `pnpm lint`** зелёные на `main`.
- [ ] **5.5 Проверить env-gated ветки**: при заданных `SELF_BASE_URL`/`CLIENT_IP_MODE=traefik`
      поведение корректно; при незаданных — прежнее (Vercel-совместимость на случай отката).

---

## 6. Чистка остатков Vercel (после подтверждения стабильности прода)

> ⚠️ Всё Vercel-специфичное сейчас **env-gated и инертно** (не мешает). Чистить ТОЛЬКО после
> решения окончательно уйти с Vercel. Каждую правку проверять `typecheck`+`test`, не ломать
> Dokploy-путь. Пока Vercel = резерв, можно оставить как есть.

- [ ] **6.1 `apps/web/vercel.json`** — Vercel Cron + `regions:[fra1]`. Cron теперь на VPS crontab.
      Удалить файл при полном уходе (или оставить — Vercel игнорируется, если проект удалён).
- [ ] **6.2 `apps/web/lib/deployment-url.ts`** — логика `VERCEL_URL`/`VERCEL_ENV` (miniAppUrl,
      siteUrl, deploymentBaseUrl). На Dokploy `VERCEL_*` не заданы → fallback `APP_URL`. Ревью:
      упростить, убрав Vercel-ветки, ИЛИ оставить для отката. `MINIAPP_BASE_URL` (Vercel-специфичный,
      кабинет мимо прокси) — на Dokploy не нужен (кабинет через www). Проверить, что не задан.
- [ ] **6.3 `apps/web/lib/tool-handlers/confirm-order.ts`** — self-call: приоритет `SELF_BASE_URL`
      (задан на Dokploy), fallback `VERCEL_URL`→`APP_URL`. Vercel-ветку можно убрать после ухода.
- [ ] **6.4 `apps/web/lib/env.ts`** — `VERCEL_ENV`, `MINIAPP_BASE_URL`, `LOVEANDPAY_PROXY_URL`
      (squid, больше не нужен), `PROXY_SHARED_SECRET` (Timeweb, больше не нужен). Ревью на удаление.
      `SUPABASE_*` уже optional (не используются в рантайме) — можно удалить из схемы полностью.
- [ ] **6.5 `logger.ts` / `sentry.ts` / `health/route.ts`** — `process.env.VERCEL_ENV ?? NODE_ENV`
      fallback (метаданные окружения). На Dokploy → NODE_ENV. Косметика, можно оставить/упростить.
- [ ] **6.6 `preferredRegion = 'fra1'`** экспорты в route-файлах — инертны вне Vercel. Убрать при чистке.
- [ ] **6.7 `.vercel/` директория** (linked project, в `.gitignore`) — можно оставить (для CLI-доступа
      к Vercel-резерву) или удалить после ухода. НЕ коммитить.
- [ ] **6.8 `@vercel/*` пакеты** — проверено, в зависимостях НЕТ. Подтвердить: `grep -r "@vercel/" package.json`.
- [ ] **6.9 CLAUDE.md** — секция «Deployments» описывает Vercel. **Переписать** под Dokploy/VPS
      (домены, сервисы, cron на crontab, TLS lego, self-host Redis/Postgres, бэкапы R2).
      Обновить инвариант 9 (getClientIp: `CLIENT_IP_MODE=traefik` вместо Vercel `x-real-ip`).
- [ ] **6.10 `docs/`** — обновить `architecture.md`, `monitoring.md` под новую инфру.
      Перенести суть этого отчёта в постоянную доку. `docs/dokploy-migration-plan.md` — история.

---

## 7. Чистка инфраструктуры (по мере остывания резерва)

- [ ] **7.1 Vercel-проект** — держать резервом **1–2 недели**. После стабильности: отключить
      автодеплой → снять домены → удалить деплой/проект. НЕ раньше.
- [ ] **7.2 Timeweb-прокси** (`104.171.133.70`) — простаивает (www не резолвится на него).
      Убрать конфиги (`/etc/dokploy/traefik/dynamic/oplatishka.yml`, `/opt/oplatishka-proxy/Caddyfile`),
      DNS `beta.oplatishka.com`. НЕ трогать другие проекты на том VPS.
- [ ] **7.3 squid-прокси L&P** (`177.7.34.106:24128`, Hostinger) — приложение больше не ходит
      через него (`LOVEANDPAY_PROXY_URL` не задан, egress VPS = задекларированный IP). Погасить.
- [ ] **7.4 Supabase-прод** (`nyxijwpuvctmvemaemqn`) — НЕ удалять **≥ месяц** (страховка данных).
- [ ] **7.5 Upstash** (старый rate-limit) — после подтверждения self-host Redis: отключить.
- [ ] **7.6 Bot-webhook вернуть на `www`** когда Telegram обновит DNS-кэш (сейчас на `new` —
      работает, оба VPS). Проверить `getWebhookInfo` ip=`177.7.34.106` для www, тогда переставить.

---

## 8. Известные хвосты и риски

- **Bot-webhook на `new`, не `www`** — работает (тот же контейнер), но семантически временно.
  Вернуть на www после обновления Telegram DNS-кэша (п. 7.6).
- **Cert-renewal — self-managed** (lego cron), не авто-Traefik. Проверить, что cron отработает
  (лог `/var/log/lego-renew.log`) до истечения 90 дней (первый renewal ~2026-10).
- **SPOF**: prod-app + БД на одном VPS. При росте — вынести Postgres на отдельную ноду (см.
  `docs/dokploy-migration-plan.md`, целевая архитектура).
- **Backup RPO 24ч** (суточный dump). При реальном трафике — добавить PITR (wal-g).
- **VPS перегружался** во время cutover (билд + операции) — SSH обрывался. Мониторить RAM/CPU (Beszel).
- **Rollback**: Vercel-прод + Supabase живы. Откат = DNS www/apex → `104.171.133.70` (Timeweb→Vercel)
  + webhook бота на www + L&P webhook назад. Минуты. Данные в Supabase на момент cutover.

---

## 9. Ссылки на историю

- `docs/dokploy-migration-plan.md` — полный план переезда с фазами (0–5), runbook, rollback.
- Память проекта: `dokploy_migration_plan.md` (детали, урок про порядок DNS/ACME).
- CLAUDE.md — источник правды по продукту/инвариантам (секцию Deployments обновить, п. 6.9).
