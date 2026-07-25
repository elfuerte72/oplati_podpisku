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

- [x] **3.1 Резолв доменов** — ПОДТВЕРЖДЕНО 2026-07-24 19:10 UTC: www/apex/new/dev → `177.7.34.106`
      (Cloudflare DoH). Заголовки ответа www/apex/new: `x-powered-by: Next.js`, ни одного `x-vercel-*`
      → отдаёт наш контейнер за Traefik. TLS: LE-сертификат `CN=oplatishka.com`, SAN `oplatishka.com`
      + `www.oplatishka.com`, до 2026-10-22.
- [x] **3.2 Webhook'и** — ПОДТВЕРЖДЕНО: `getWebhookInfo` → `https://new.oplatishka.com/api/bot`,
      `ip_address 177.7.34.106`, `pending_update_count 0`, `last_error_date null`.
      Эндпоинт L&P на новом стеке живой (в логах 18:41 UTC — `invalid_payload` + `invalid_signature`
      от тестовых вызовов; реальный контракт подтвердится только живой оплатой, см. 4.6).
- [x] **3.3 Vercel ПОЛУЧАЕТ трафик — проверка ПРОВАЛЕНА.** Runtime Logs за 100 мин ПОСЛЕ cutover:
      `/` 226, `/api/cron/poll-payment` 20, `/api/cron/expire-payments` 6, `/api/cron/referral-recovery` 1,
      `/api/cron/keepalive` 1, `/api/auth/telegram/link` 2 + `/status` 10, `/api/profile` 5,
      `/api/chat/history` 5, `/partner` 7. Прод-деплой Vercel обновляется автоматически (autoDeploy на
      `main` включён и на Vercel, и на Dokploy). Vercel пишет в **Supabase**: строка `link_tokens`
      в 19:03:18.220 UTC совпала с логом `db.link_tokens.created` в 19:03:18.262 UTC.
      → **живой split-brain, см. раздел 10 (S-1).**
- [ ] **3.4 Тест «пауза Vercel»** (по желанию, 100%-доказательство): в Vercel Settings → Domains
      временно снять `www.oplatishka.com` + `oplatishka.com` (они уже не резолвятся на Vercel,
      привязка косметическая) ИЛИ отключить Git-автодеплой (Settings → Git). Если сайт/бот/платежи
      продолжают работать — всё на Dokploy. **Полностью деплой Vercel НЕ удалять** (резерв).
      Примечание: у Vercel нет кнопки «pause project»; ближайшее — отключить автодеплой и/или
      снять домены. Реальную остановку обслуживания даёт только удаление деплоя — НЕ делать сейчас.
- [x] **3.5 Данные синхронны** — ПОДТВЕРЖДЕНО прямым запросом в оба Postgres 2026-07-24 19:2x UTC:
      orders 133 / messages 826 / payments 46 / users 75 / order_events 342 / conversations 131 —
      **совпадает 1:1**. В журнале `drizzle` нового Postgres 25 миграций.
      Инварианты пережили перенос: триггер `order_events_append_only` есть и включён (инвариант 1),
      RLS включён на 17/17 таблиц, единственная политика — `services_public_read_active` для
      `{anon,authenticated}` (инварианты 7 и 8).
      ⚠️ Supabase уже НЕ заморожен: `link_tokens` растёт из-за трафика на Vercel (см. 3.3).
      Клиентских `orders`/`payments` там с 2026-07-22 не прибавилось.

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

- [x] **5.1 `/full-review` прогнан** 2026-07-24 на `main`, охват — миграционный diff `2b86e1f..2d07149`
      (PR #99, 12 файлов). Все 5 осей загейчены и отработали. Полный отчёт — раздел 10.
      Сводка: A — 0 BLOCKER, 3 MEDIUM · B — 1 HIGH, 3 MEDIUM · C — 3 MEDIUM, 2 LOW ·
      D — 1 HIGH, 1 MEDIUM · E — 1 HIGH, 7 MEDIUM. **BLOCKER'ов нет.**
- [x] **5.2 Инварианты CLAUDE.md переезд НЕ нарушил.** Проверено по коду и на живой БД:
      append-only-триггер на месте и включён, RLS 17/17 + единственная public-read политика каталога,
      `claimPaymentSucceeded` / `UNIQUE(provider, provider_ref)` / 200 OK / `transitionOrder` /
      денежные integer-поля — код не тронут диффом. `init-roles.ts` RLS-модель не ослабляет
      (`anon`/`authenticated` создаются `NOLOGIN` без единого GRANT — строже, чем на Supabase).
      Единственное отступление — инвариант 9 в CLAUDE.md описывает Vercel-режим; фактический
      прод теперь на `CLIENT_IP_MODE=traefik` (текст надо обновить, п. 6.9).
- [x] **5.3 Контракты живьём.** PaySpace — ОК: `vcc_balance.ok` в каждом прогоне `poll-payment`
      (баланс $104.60). Anthropic — `ANTHROPIC_MODEL=claude-sonnet-4-6` задан. Remnawave — токен
      задан, `REMNAWAVE_SQUAD_UUID` имеет дефолт (не задавать нормально). Rapira — вызывается только
      на `propose_order`, за 24 ч вызовов не было → проверяется смоуком 4.6.
      L&P — эндпоинт живой, но реальную подпись подтвердит только живая оплата (4.6).
      **Sentry — НЕ работает (S-2).**
- [x] **5.4 Зелёные на `main`**: `pnpm typecheck` 4/4 ОК · `pnpm lint` 0 ошибок (2 warning:
      неиспользуемые `Card` в `lib/cabinet/read.ts:13` и `_text` в `lib/jobs/proxy-health.test.ts:8`) ·
      web 440/440 · `@oplati/types` 110/110 · `@oplati/db` 32/32 (PGlite).
- [x] **5.5 Env-гейты проверены.** На Dokploy заданы `SELF_BASE_URL=http://127.0.0.1:3000` (self-call
      замкнут в контейнер) и `CLIENT_IP_MODE=traefik`; `VERCEL_*` не заданы → `deploymentBaseUrl()`
      и `miniAppBaseUrl()` корректно падают в `APP_URL`, кабинет идёт через www (гейт
      `VERCEL_ENV === 'production'` делает `MINIAPP_BASE_URL` мёртвым на self-host — п. 6.2 закрыт).
      Обратная совместимость сохранена: при незаданных гейтах поведение прежнее, Vercel-откат жив.

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

---

## 10. Находки проверки 2026-07-24 (верификация + `/full-review`)

Порядок — по срочности. `S-*` — состояние контура (нашлось при верификации),
`A/B/C/D/E-*` — оси код-ревью. **BLOCKER'ов в коде нет.**

**Статус правок (ветка `chore/post-cutover-hardening`, 7 коммитов, не смёржена):**
закрыты `S-1` (автодеплой Vercel отключён + WAF-deny на кроны), `S-2` (env Sentry заполнен, нужна пересборка), `S-4` (бэкап сделан и проверен восстановлением), `S-8` (расклеена строка env), `S-9` (жёсткий срок карты 180д + сокрытие в кабинете), `A-1`, `A-4`, `B-3`, `D-1`, `D-2`, `D-3`, `E-1`, `E-2`, `E-3`, `E-4`, `E-5`, `E-7`,
`E-8`, `E-10` + код-сторона `S-1` (блок `crons` снят из `vercel.json`).
После правок: typecheck 4/4, lint 0 ошибок, тесты web **457** (было 440), `@oplati/types` 110, `@oplati/db` **36** (было 32).
Осознанно НЕ правил в этом заходе (нужно решение/доступ владельца):
`S-3`/`C-1` (секрет cron в 600-файл — правка на VPS), `S-5`/`C-3`
(отдельная роль Postgres), `S-6`/`C-4` (публичный репо), `S-7`, `S-8`, `A-2`, `A-3`, `A-5`,
`B-2`, `B-4`, `C-2`, `C-5`, `D-4`, `D-5`, `E-6`, `E-9`. `B-1` снят вместе с `S-1`.

⚠️ **`S-1` закрывается только мержем.** Vercel-cron физически перестанет запускаться, когда
Vercel соберёт production-деплой БЕЗ блока `crons`. Поэтому автодеплой Vercel надо отключать
**после** этого деплоя — если отключить раньше, резерв останется на старой конфигурации и
продолжит крутить джобы по Supabase.

### S. Состояние прода

- [x] **S-1 · ЗАКРЫТО 2026-07-25** (владелец снял домены; я отключил автодеплой и погасил cron).
      Сделано: `vercel git disconnect` — пуш в `main` больше НЕ создаёт деплой на Vercel; плюс
      WAF-правило `block-cron-after-dokploy-migration` (**deny** на `path starts with /api/cron`,
      опубликовано в production). Правило нужно потому, что у текущего прод-деплоя Vercel блок
      `crons` уже вшит в конфиг, а погасить его иначе можно только НОВЫМ production-деплоем —
      которого после отключения автодеплоя не будет. Правило снимается одной командой
      (`vercel firewall rules remove block-cron-after-dokploy-migration` + `publish`), деплой и
      возможность отката целы. Проверено по Runtime Logs: после публикации запуски `poll-payment`
      прекратились.
      Исходная проблема (для истории):
      Прод-деплой Vercel обновляется автодеплоем с `main` (последний — через 15 мин после
      начала проверки), Vercel Cron исполняется (`poll-payment` 288 раз/24 ч, `expire-payments` 96,
      `referral-recovery` 24, `recycle-cards`/`retention`/`renewal-reminder` по разу), и всё это
      пишет в **Supabase**. В 19:03 UTC — уже после cutover — реальный клиент получил
      `link_token` в Supabase; бот на Dokploy этот токен не найдёт → привязка Telegram молча ломается.
      На Vercel живы боевые ключи L&P и PaySpace: клиент, попавший на `oplati-podpisku-web.vercel.app`,
      может оформить и **оплатить** заказ в «призрачном» стеке — новый прод об этом не узнает.
      *Почему пока не рвануло:* в Supabase 0 заказов в оплатимых статусах, все `pending`-платежи
      старше 33 дней (окно `poll-payment` — 10 мин…25 ч), карт под recycle нет (idle>180д = 0,
      active>90д = 0). Т.е. окно ещё не открылось, но открывается само по мере старения карт
      (`recycle-cards` делает необратимый `release`) и при любой транзакции на призраке.
      **Действие (нужно разрешение владельца):** отключить Git-автодеплой Vercel + удалить `crons`
      из `vercel.json` ИЛИ снять домены/деплой. Резерв при этом сохраняется (проект не удаляем).
- [x] **S-2 · env ЗАПОЛНЕН 2026-07-25, ждёт пересборки.** В env приложения Dokploy записаны
      `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` (корректные значения вместо текста комментария) и
      свежий `SENTRY_ALERT_WEBHOOK_SECRET`; `NEXT_PUBLIC_SENTRY_DSN` продублирован в **Build Args**.
      Мусорный `SENTRY_AUTH_TOKEN` удалён — при непустом значении плагин Sentry включает загрузку
      source-map (`hasSentryAuth`, next.config.ts) и может ломать сборку. Заодно расклеена строка
      `PAYSPACE_WEBHOOK_SECRET`+`DEV_CRON_SECRET`, dev-секрет из прода убран (S-8).
      Проверено через API Dokploy: 33 переменные, buildArgs выставлен, buildSecrets пуст.
      **Остаётся 2 действия владельца:** (1) пересобрать приложение — серверный Sentry поднимется
      от `SENTRY_DSN` при рестарте, но клиентский и `report-uri` для CSP требуют именно нового
      билда (`NEXT_PUBLIC_*` инлайнится на сборке); (2) подставить `?s=<SENTRY_ALERT_WEBHOOK_SECRET>`
      в URL alert-rule в Sentry, иначе алёрты в Telegram по правилам Sentry молчат.
      Исходная проблема (для истории):
      В env Dokploy нет `SENTRY_DSN`, а `NEXT_PUBLIC_SENTRY_DSN` содержит не DSN, а текст комментария
      («# тот же DSN, но публичный…»); `SENTRY_AUTH_TOKEN` — тоже комментарий. Плюс
      `NEXT_PUBLIC_SENTRY_DSN` — это build-ARG (`Dockerfile:27`), а `buildArgs` приложения = null,
      т.е. в клиентский бандл DSN не запёкся. Подтверждение: в логах контейнера за час нет ни одного
      упоминания Sentry; последнее событие в Sentry — 16:33 UTC, до cutover (17:25).
      Следствие: ошибки денежного пути (webhook L&P, PaySpace, токен-бюджет) не видны нигде,
      кроме stdout-логов, а Sentry-алёрты в Telegram мертвы вдвойне — `SENTRY_ALERT_WEBHOOK_SECRET`
      тоже не задан (`/api/alerts/sentry` тихо отвечает `200 {skipped:'not_configured'}`).
      Прямые ops-DM (`notifyOps`: proxy-health, недоплаты) работают — `ALERT_BOT_TOKEN` задан.
      **Что задать (DSN получен из Sentry 2026-07-25; он публичный по устройству — уезжает
      в клиентский бандл, секретом не является):**
      `https://47dd5bb82227490cfcb0ee422d16bec6@o4511590914654208.ingest.de.sentry.io/4511590916358224`
      1. **`SENTRY_DSN`** — в runtime-env приложения Dokploy. Это закрывает СЕРВЕРНУЮ сторону
         (webhook L&P, PaySpace, cron, токен-бюджет), т.е. весь денежный путь. Читается в
         рантайме (`sentry.server.config.ts`: `SENTRY_DSN ?? NEXT_PUBLIC_SENTRY_DSN`) — хватит
         перезапуска контейнера.
      2. **`NEXT_PUBLIC_SENTRY_DSN`** — ТОЛЬКО как **build-arg** Dokploy (`Dockerfile:27` объявляет
         `ARG`). В runtime-env он бесполезен: Next инлайнит `NEXT_PUBLIC_*` на этапе сборки, а
         `buildArgs` приложения сейчас пустые — именно поэтому клиентский Sentry мёртв. Нужен
         пересбор образа.
      3. **`SENTRY_ALERT_WEBHOOK_SECRET`** — сгенерировать (`openssl rand -hex 32`), положить в env
         и подставить в URL alert-rule Sentry (`?s=<секрет>`), иначе алёрты в Telegram по правилам
         Sentry молчат.
      4. Для загрузки source-map в CI (необязательно): org `oplatishka`, project
         `sentry-byzantium-battery`, плюс `SENTRY_AUTH_TOKEN` (сейчас в нём тоже текст комментария).
- [ ] **S-3 · ВЫСОКО · `CRON_SECRET` утекает в syslog и лежит в 644-файле.**
      `/etc/cron.d/oplatishka` — `-rw-r--r--` с секретом открытым текстом, и cron пишет **всю
      командную строку вместе с `Authorization: Bearer <секрет>` в `/var/log/syslog`** при каждом
      запуске (77 записей). Плюс секрет виден в `ps`/`/proc/<pid>/cmdline`. Владелец секрета
      дёргает `retention` (удаление `messages`) и `recycle-cards` (реальный `release` карт = деньги).
      Смягчает: `/opt/alloy/config.alloy` файлы `/var/log` не собирает — в Loki секрет не уезжает.
      Фикс: секрет в отдельный `600`-файл, вызов через `curl --config` / обёртку-скрипт; `/etc/cron.d/*` → 600.
- [x] **S-4 · ЗАКРЫТО · Бэкап сделан и проверен восстановлением 2026-07-25.**
      Подозрение подтвердилось размерами объектов в R2:
      `2026-07-24T15-34-28.sql.gz` — **13 КБ** (тот дамп снят ДО переноса данных, клиентских
      строк в нём практически нет), `2026-07-25T03-00-00.sql.gz` — **333 КБ** (первый штатный
      после cutover, отработал сам), `2026-07-25T05-53-59.sql.gz` — **333 КБ** (ручной прогон).
      **Restore-тест на свежем артефакте** (скачан из R2, восстановлен в отдельную БД
      `oplatishka_restore_test` в том же инстансе, затем удалена):
      `pg_restore` exit 0, ноль ошибок; orders 133 / messages 826 / payments 46 / users 75 /
      order_events 342 / conversations 131 / services 37 и **сумма платежей 27 597 300 копеек —
      совпали с продом до копейки**; 17 таблиц, RLS 17/17, политика
      `services_public_read_active`, 25 миграций в журнале `drizzle`; триггер
      `order_events_append_only` не просто присутствует — живой `UPDATE order_events` в
      восстановленной БД отбит с «append-only: UPDATE blocked (invariant #1)».
      ⚠️ **Для рунбука:** дамп в **custom-формате `pg_dump -Fc`**, несмотря на расширение
      `.sql.gz` — восстанавливать `gunzip -c … | pg_restore -d <db> --no-owner`, а НЕ
      `psql < dump.sql` (последнее просто упадёт). Ключ в R2:
      `dokploy-backups/oplatishka-db-ry3smb/oplatishka-db/<ISO>.sql.gz`.
      Остаётся прежний RPO 24 ч (суточный дамп) — PITR см. раздел 8.
- [ ] **S-5 · СРЕДНЕ · Приложение ходит в Postgres суперюзером.** Роль `oplatishka` —
      `rolsuper=t`, `rolbypassrls=t` (так создаёт образ `postgres:17`). Утечка `DATABASE_URL`
      (панель Dokploy, дамп в R2, лог) даёт не scoped-роль, а полный суперюзер: можно
      `ALTER TABLE order_events DISABLE TRIGGER` — DB-уровневая защита инварианта 1 перестаёт
      быть защитой. На Supabase таких прав у приложения не было. Фикс: отдельная роль
      `NOSUPERUSER BYPASSRLS` с GRANT только на `public`; суперюзер — только миграции/init-roles.
- [ ] **S-6 · СРЕДНЕ · Репозиторий публичный** (`elfuerte72/oplati_podpisku`, `visibility: PUBLIC`),
      а `docs/dokploy-migration-plan.md` + `.mcp.json` публикуют URL панели Dokploy
      (`dokploy.mxpkn8ns.ru`), внутренние хосты сервисов, логин Basic Auth dev-стенда, имя R2-бакета.
      Токенов не закоммичено (`${DOKPLOY_API_KEY}` — подстановка), `infra/crontab.example` содержит
      только плейсхолдеры — проверено. Фикс: панель за IP-allowlist/VPN, инфра-хосты вынести из
      публичного репо.
- [ ] **S-7 · НИЗКО · Заголовок `Alt-Svc: h3` вернулся.** На Timeweb-схеме его специально снимали
      middleware'ом (ТСПУ режет QUIC). Новый Traefik его рекламирует. VPS доступен из РФ напрямую,
      так что скорее всего безвредно, но если у кого-то сайт «моргает» на мобильном — начинать отсюда.
- [x] **S-8 · ЧАСТИЧНО ЗАКРЫТО 2026-07-25 · Разное по env/конфигу.**
      ✅ Склеенная строка `PAYSPACE_WEBHOOK_SECRET=<...>DEV_CRON_SECRET=<...>` расклеена: у
      `PAYSPACE_WEBHOOK_SECRET` теперь чистое значение (43 символа = base64url от 32 байт — граница
      восстановлена однозначно, dev-секрет начинался ровно с имени переменной), а `DEV_CRON_SECRET`
      из прод-env удалён (dev-значению там не место). Функционально было безвредно —
      `PAYSPACE_WEBHOOK_SECRET` в коде не читается.
      ⬜ Осталось: **`TELEGRAM_MINIAPP_SHORTNAME` задать не смог** — значение живёт в @BotFather и
      через Bot API не читается. Без него кнопка «Личный кабинет» на сайте уходит через
      `?start=cabinet`-меню вместо прямой ссылки (регресс UX, не поломка; реф-ссылки не затронуты —
      `REFERRAL_MINIAPP_DEEPLINK` выключен). Взять short name в @BotFather → Bot Settings →
      Menu Button / Web App и дописать в env.
      ⬜ Описание приложения в Dokploy всё ещё «ветка feat/dokploy-migration», фактически — `main`.
      ⬜ Баланс VCC $104.60 при пороге алёрта $50 — на пару заказов.

- [x] **S-9 · ИСПРАВЛЕНО 2026-07-25 (решение владельца: без предупреждений клиенту).**
      Сделано: `findCardsToRecycle` берёт `active` И `idle` — срок жизни жёсткий, от выпуска
      (следствие 3 закрыто, карта реально закрывается на 180-й день в любом статусе); выборки
      кабинета (`findCardsByUserIdForCabinet`, `findCardByIdForUser`) отсекают карты старше срока,
      поэтому просроченная исчезает из кабинета и по ней не отдаются реквизиты даже в окне до
      прогона cron или при упавшем `releaseCard`; сроки 90/180 вынесены в
      `@oplati/types/card-lifecycle` как единый источник вместо SQL-литералов + отдельной
      константы витрины. Тесты PGlite 32 → 37, регресс-тест проверен на прове (с прежним условием
      `status='idle'` падает ровно он).
      **Осознанно НЕ делаем:** предупреждение клиенту перед закрытием карты (решение владельца).
      **Следствие 2 (денежное) — тоже закрыто, решение владельца 2026-07-25: один срок вместо двух.**
      Разбор показал, что правило «90 дней простоя → `idle`» осталось от ОТМЕНЁННОЙ схемы, где
      закрытая карта уходила в пул и выдавалась ДРУГОМУ клиенту; пул-функция `findRecyclableCard`
      была мёртвым кодом (вызовов нет, только мок в тесте). Единственным живым эффектом 90 дней
      было вредное: на 91-й день клиент терял право на долив, и повторный заказ выпускал новую
      карту с надбавкой $4 — при обещанных кабинетом 180 днях. «Продлить» карту клиент не мог:
      кнопки пополнения нет, долив бывает только побочным эффектом нового заказа.
      Сделано: возрастное идление убрано, карта доливается без надбавки весь срок
      `CARD_LIFETIME_DAYS`; `idle` ставит только `issue-card` при ОТКЛОНЁННОМ доливе (карта
      протухла/заблокирована) — настоящий вывод из реюза; удалены `findRecyclableCard`,
      `idleAgedActiveCards` и их следы. Срок закрытия не сдвинулся (он и так от выпуска), поэтому
      остаток буфера не подвисает дольше. В кабинете под «Действует до» добавлена строка о том,
      что после этой даты карта закроется и выпуск новой добавится к сумме заказа.
      Тесты: web 457, types 110, db 36. CLAUDE.md приведён в соответствие.
      Исходный разбор:
      Механика: шаг 1 `active → idle` при `COALESCE(last_used_at, created_at) < now() - 90 days`
      (`cards.ts:249`); шаг 2 `idle → releaseCard` при `created_at < now() - 180 days`
      (`cards.ts:267`). `last_used_at` пишет только `updateBalance` (наш топап) и `markIdle`;
      `syncCardBalance` его осознанно НЕ трогает. У свежей карты `last_used_at IS NULL`.
      Следствие 1 (безобидное): `idle` — чисто БД-метка, вызова в PaySpace нет, карта физически
      живёт до 180 дней, как и обещает кабинет («Действует до» = `createdAt + CARD_LIFETIME_DAYS`,
      `cabinet/read.ts:83`). Пороги согласованы.
      Следствие 2 (денежное): `findActiveByUserId` матчит ТОЛЬКО `status='active'`
      (`cards.ts:83`), поэтому после 90-го дня без топапов повторный заказ клиента не топапит
      старую карту, а выпускает НОВУЮ — клиент снова платит `CARD_ISSUE_FEE_USD_CENTS` ($4),
      хотя прежняя карта ещё жива и с остатком. Проверить, такой ли расчёт задуман.
      Следствие 3 (риск): подписка, которая списывает с карты сама, для нас невидима — на 180-й
      день карта закрывается `releaseCard` (необратимо), и **клиента об этом никто не
      предупреждает**: `subscription-renewal-reminder` работает по заказам, не по картам
      (проверено — карты в джобе не упоминаются). Нужен либо предупреждающий алёрт клиенту за
      N дней до `createdAt + 180д`, либо продление срока при живой подписке.

### A. БД и состояния

- [x] **A-1 · MEDIUM · `packages/db/scripts/init-roles.ts:31`** — приоритет env инвертирован
      относительно `drizzle.config.ts` (`DATABASE_URL_DIRECT ?? DATABASE_URL`): скрипт берёт
      `DATABASE_URL` первым. Задокументированный в CLAUDE.md запуск с переопределением только
      `DATABASE_URL_DIRECT` создаст роли не в той БД (вплоть до прод-Supabase, где DO-блок молча
      скипнет и напечатает «roles ready»), а `db:migrate` упадёт на 0010 «role does not exist».
- [ ] **A-2 · MEDIUM · `docs/dokploy-migration-plan.md:208-220`** — верификация переноса сверяет
      COUNT/суммы/sequences, но не наличие триггера `order_events_append_only`, RLS-политик и
      журнала `drizzle`. `psql` без `ON_ERROR_STOP` продолжает после упавших операторов → restore
      «успешен», а инвариант 1 держится на честном слове. *(Фактически на этом проде всё на месте —
      проверено, п. 3.5; правка нужна в рунбуке, чтобы следующий restore это проверял.)*
- [ ] **A-3 · MEDIUM · `Dockerfile:50` + `apps/web/lib/env.ts:63`** — `HEALTHCHECK` бьёт в
      `/api/health`, который БД не трогает, а `DATABASE_URL` в схеме — `optionalUrl()`. После
      перевода `SUPABASE_*` в optional обязательных DB-переменных не осталось: опечатка в хосте
      (а имя `oplatishka-db-ry3smb` меняется при пересоздании сервиса) → контейнер `healthy`,
      Dokploy докатывает релиз, весь путь заказ→оплата падает в рантайме.
- [x] **A-4 · LOW · `infra/crontab.example:21`** — нет `CRON_TZ=UTC`. *Фактически VPS в `Etc/UTC`
      (проверено), так что расхождения нет* — но пин стоит поставить явно: смена TZ хоста сдвинет
      `referral-rollup` в прошлый месяц, а PK-идемпотентность превратит это в тихий skip.
- [ ] **A-5 · LOW · `docs/dokploy-migration-plan.md:172`** — дамп с `--no-acl` не переносит
      `GRANT SELECT ON services TO anon, authenticated` из 0010, а повторно миграция не прогонится.
      Сейчас инертно (роли `NOLOGIN`, anon-клиента нет), направление fail-closed.

### B. Платежи и идемпотентность

- [ ] **B-1 · HIGH · `infra/crontab.example` + `apps/web/vercel.json`** — at-most-once действует
      только внутри ОДНОЙ БД, а PR добавил второй парк кронов, не сняв `crons` у Vercel.
      Это код-сторона S-1: инвойс, висевший `pending` на момент cutover и оплаченный после, увидят
      оба `poll-payment` → два `processInvoicePaid` → две карты PaySpace (цена + буфер + $4),
      два DM клиенту, два реф-начисления. *Сегодня не стреляет — окно 25 ч уже закрыто.*
- [ ] **B-2 · MEDIUM · дедуп `renewal_reminder_sent`** — read-then-write, не атомарный. Vercel Cron
      `0 7 * * *` и системный `0 7 * * *` стартуют одновременно → напоминание уйдёт дважды.
- [x] **B-3 · MEDIUM · `infra/crontab.example:14`** — комментарий «ошибка в stderr → cron шлёт её
      в syslog» неверен: cron отдаёт stderr в MTA, а MTA на VPS нет (проверено: `sendmail`/`postfix`/
      `exim4` отсутствуют), `MAILTO` не задан. Отвал `poll-payment` (401 после ротации секрета,
      протухший серт, лежит Traefik) = мёртвый backstop потерянных webhook'ов, молча.
      Фикс: `2>&1 | logger -t oplatishka-cron` + внешний heartbeat.
- [ ] **B-4 · LOW · `apps/web/lib/tool-handlers/confirm-order.ts:133`** — `SELF_BASE_URL` безусловно
      приоритетнее и не проверяется на «свой хост»: ошибочное значение создаст инвойс в чужом стеке
      и отдаст `X-Internal-Token` промежуточным прокси. *На проде задан корректный `127.0.0.1:3000`.*

### C. Безопасность и PII

- [ ] **C-1 · MEDIUM · `infra/crontab.example:8,10,30-42`** — см. S-3 (секрет в 644-файле и в argv).
- [ ] **C-2 · MEDIUM · `apps/web/lib/env.ts:277-280`** — `CLIENT_IP_MODE` дефолтит в `'vercel'`,
      т.е. на целевой платформе безопасный режим **opt-in**, и рантайм не проверяет, что self-host
      запущен без него. Пересоздали приложение / потеряли env → `curl -H 'x-real-ip: <random>'`
      обнуляет per-IP лимит на каждом запросе (CWE-348) → cost-DoS на строки и AI-бюджет, без алёрта.
      Фикс: дефолт по признаку платформы (`VERCEL === '1' ? 'vercel' : 'traefik'`) либо fail-fast/
      Sentry-warn при `NODE_ENV=production && !VERCEL && CLIENT_IP_MODE==='vercel'`.
- [ ] **C-3 · MEDIUM · `packages/db/scripts/init-roles.ts:19-21`** — см. S-5 (приложение суперюзером).
- [ ] **C-4 · LOW · `.mcp.json` + план миграции** — см. S-6 (публичный репо).
- [ ] **C-5 · LOW · `packages/db/scripts/init-roles.ts:36,63`** — локальный `pino` в обход
      `apps/web/lib/logger.ts` с его redact-листом: `logger.error({ err })` сериализует ошибку
      `postgres`-клиента без скраба (детали соединения → stdout → Loki).

### D. Границы и архитектура

- [x] **D-1 · HIGH · `.dockerignore:20-21`** — `.env` / `.env.*` матчатся только от корня контекста
      (для `node_modules`/`.next` автор писал `**/`, здесь — нет). Реально существуют `apps/.env`,
      `apps/web/.env.local`, `packages/db/.env`, `packages/db/.env.local` → при **локальном**
      `docker build .` они попадают в build-стадию и читаются `next build` (инлайн `NEXT_PUBLIC_*`).
      Прод не затронут: Dokploy собирает из git-клона, где этих файлов нет. Фикс: `**/.env`, `**/.env.*`.
- [x] **D-2 · MEDIUM · `confirm-order.ts:132-136` + `deployment-url.ts:16-35`** — `deployment-url.ts`
      заведён «чтобы Vercel-логика не разъезжалась», но self-host-ветка (`SELF_BASE_URL`) добавлена
      мимо него, а сам модуль остался чистым Vercel-детектом. Тесты `deployment-url.test.ts` все
      выставляют `VERCEL_ENV` — self-host-путь не покрыт.
- [x] **D-3 · LOW · `packages/db/tsconfig.json:7`** — `include: ["src/**/*"]`, поэтому
      `scripts/init-roles.ts` и `seed-catalog.ts` вне `tsc`. Дрейф типов в скрипте, который ходит
      по боевой БД, всплывёт только в рантайме на VPS.
- [ ] **D-4 · LOW · `Dockerfile:13-17`** — манифесты перечислены поимённо вразрез с глобами
      `pnpm-workspace.yaml`: добавили `packages/<новый>` → `pnpm install --frozen-lockfile` падает.
- [ ] **D-5 · LOW · docs-дрейф** — CLAUDE.md не знает про `SELF_BASE_URL`/`CLIENT_IP_MODE`, про
      optional-`SUPABASE_*` и MCP `dokploy`; инвариант 9 описывает только Vercel-режим. Плюс
      `infra/crontab.example` — второй источник правды расписаний рядом с `vercel.json`.

### E. Корректность и тесты

- [x] **E-1 · HIGH · `infra/crontab.example:24-43`** — сбой cron глотается молча (то же, что B-3).
- [x] **E-2 · MEDIUM · `apps/web/lib/ratelimit.ts:107-109`** — в traefik-режиме нет fallback: нет
      `x-forwarded-for` → `unknown` для всех. Запрос мимо Traefik (прямой хит порта контейнера,
      внутренний вызов) → все такие клиенты в одном bucket → 429 живым пользователям.
- [x] **E-3 · MEDIUM · `apps/web/lib/ratelimit.ts:119-126`** — извлечённое значение не валидируется
      как IP. `x-forwarded-for: 1.2.3.4:56789` (или `[2001:db8::1]:443`) → эфемерный порт меняется
      каждое соединение → per-IP лимит обходится полностью.
- [x] **E-4 · MEDIUM · `apps/web/lib/ratelimit.test.ts:238-296`** — покрыт только happy path режима:
      нет пустого XFF, мусора `", ,"`, IPv6/порта, `CLIENT_IP_MODE=''`, и комбинации
      `PROXY_SHARED_SECRET` + traefik.
- [x] **E-5 · MEDIUM · `confirm-order.ts:130-136`** — денежный путь (резолв базы self-call'а)
      переписан, а тестов у `confirm-order.ts` нет вообще.
- [ ] **E-6 · MEDIUM · `Dockerfile:52`** — нет graceful shutdown: `node` PID 1 без init, standalone
      Next 16 на SIGTERM делает `process.exit(143)` без дренажа. Rolling-update во время POST
      `/api/payments/loveandpay` → соединение рвётся, заказ остаётся в `paid`; спасает только
      `poll-payment` (см. B-3/E-1 — который молчит при сбое).
- [x] **E-7 · MEDIUM · `.dockerignore:19-21`** — дубль D-1.
- [x] **E-8 · LOW · `init-roles.ts:41`** — нет `connect_timeout`: недоступная БД → скрипт висит вечно.
- [ ] **E-9 · LOW · `init-roles.ts` vs `packages/db/src/integration.test.ts:143`** — роли задаются
      дважды и расходятся (`service_role … BYPASSRLS` в скрипте, без него в PGlite) → тест проверяет
      не тот контур, что едет в прод.
- [x] **E-10 · LOW · `infra/crontab.example:25`** — `-m 290` при интервале 300 с без `flock`:
      перекрытие `poll-payment` возможно (побочки защищены атомарными claim'ами → только LOW).

---

## 11. Остатки Vercel в коде: инвентаризация и план чистки

**Принцип:** пока Vercel = резерв отката, `VERCEL_*`-ветки — это страховка, а не мусор.
Вредны только те остатки, что **действуют** (cron) или **вводят в заблуждение** (доки).
Порядок ниже — по убыванию риска; шаги 3–4 делать только после решения уйти с Vercel окончательно.

| # | Остаток | Где | Риск | Действие |
|---|---|---|---|---|
| 1 | `crons` (8 джобов) | `apps/web/vercel.json:4-13` | **ВЫСОКИЙ — действует** | Убрать сейчас (см. S-1/B-1) |
| 2 | `MINIAPP_BASE_URL` на Vercel | env Vercel Production | СРЕДНИЙ — уводит кабинет на призрак | Снять вместе с деплоем |
| 3 | `LOVEANDPAY_PROXY_URL`, `PROXY_SHARED_SECRET` | env + `lib/env.ts:122,259-268` | НИЗКИЙ — не заданы на Dokploy, ветки мертвы | Удалить в шаге «уход с Vercel» |
| 4 | `VERCEL_URL`/`VERCEL_ENV` в резолве URL | `lib/deployment-url.ts:16,31`, `lib/tool-handlers/confirm-order.ts:132` | НИЗКИЙ — инертны, нужны для отката | Оставить до отказа от резерва; при чистке — вместе с D-2 |
| 5 | `VERCEL_ENV ?? NODE_ENV` | `lib/logger.ts:73,90`, `lib/sentry.ts:85`, `app/api/health/route.ts:25` | НИЗКИЙ — косметика метаданных | Упростить при чистке |
| 6 | `preferredRegion = 'fra1'` | 25 route-файлов | НУЛЕВОЙ — вне Vercel игнорируется | Убрать одним проходом при чистке |
| 7 | `SUPABASE_*` в env-схеме | `lib/env.ts:60-62` | НУЛЕВОЙ — в рантайме не читаются | Удалить из схемы при уходе |
| 8 | `KV_REST_API_*` fallback | `lib/ratelimit.ts:139` | НУЛЕВОЙ — на Dokploy `UPSTASH_*` | Оставить (безвредный fallback) |
| 9 | `.vercel/`, `.vercelignore` | корень | НУЛЕВОЙ, в `.gitignore` | Оставить ради CLI-доступа к резерву |
| 10 | `@vercel/*` пакеты | — | **отсутствуют**, подтверждено | — |
| 11 | Комментарии/доки про Vercel | ~40 мест + CLAUDE.md «Deployments» | СРЕДНИЙ — вводит в заблуждение | Переписать (п. 6.9/6.10) |
| 12 | `beta.oplatishka.com` | DNS → Timeweb → Vercel | НИЗКИЙ — отдаёт `404 DEPLOYMENT_NOT_FOUND` | Снять с DNS (п. 7.2) |

**Порядок чистки (каждый шаг — отдельный коммит, `pnpm typecheck` + тесты после каждого):**

1. **Сейчас, до всего остального:** снять `crons` из `vercel.json` + отключить автодеплой Vercel.
   Это гасит split-brain, но НЕ трогает возможность отката (деплой и домены остаются).
2. **Сейчас:** правки, не зависящие от судьбы Vercel — `**/.env*` в `.dockerignore` (D-1),
   `CRON_TZ=UTC` + логирование stderr в crontab (A-4/B-3/E-1), `connect_timeout` и приоритет env
   в `init-roles.ts` (A-1/E-8), нормализация IP + fallback в `getClientIp` (E-2/E-3) с тестами (E-4),
   тест на `confirm-order` (E-5), `scripts/**` в tsconfig (D-3).
3. **После недели стабильности:** `preferredRegion`, `VERCEL_ENV ?? NODE_ENV`, `SUPABASE_*` из схемы.
4. **После решения уйти окончательно:** `vercel.json`, Vercel-ветки в `deployment-url.ts` /
   `confirm-order.ts` (слить с `SELF_BASE_URL` в один источник правды — D-2), `LOVEANDPAY_PROXY_URL`,
   `PROXY_SHARED_SECRET`, переписать CLAUDE.md «Deployments» и инвариант 9, обновить `docs/`.

---

## 12. Пошаговый смоук-чек-лист владельцу (раздел 4, развёрнуто)

⚠️ Живой прод: тестовые заказы создают реальные инвойсы L&P. Бери сервис с минимальной суммой
(≥500 ₽ — `LOVEANDPAY_MIN_AMOUNT_RUB`) и помни про $4 issue-fee, если активной карты нет.
Перед стартом — договорись, гасим ли Vercel-cron (S-1): пока он жив, шаг 6 может задвоиться.

**Блок 1 — сайт (мобильный, БЕЗ VPN, оператор РФ):**
1. Открой `www.oplatishka.com` — грузится первый экран УТП, стили на месте, нет «моргания».
2. «Как это работает» — 3 шага с прогрессом «N из 3».
3. «Выбрать сервис» → карточка → блок «Важно перед оплатой» (пер-сервисные правила).
4. Проверь, что кнопка оплаты содержит сумму («Оплатить N ₽») и раскрывашку «Как рассчитана сумма».
5. Открой `oplatishka.com` (без www) — тоже работает.

**Блок 2 — бот (`@oplatishkaa_bot`):**
6. `/start` → GREETING + inline-меню: «Открыть приложение», «Сайт», «Поддержка», «Telegram-канал», «VPN».
7. «VPN» → приходит альбом скриншотов + ссылка-подписка в `<code>`. Нажми «Обновить ссылку» —
   ссылка меняется, срок НЕ продлевается.
8. `/support` → бот просит описать проблему → отправь текст → проверь, что обращение пришло
   оператору (chat `379336096`).
9. «Сайт» — ведёт на `/?src=tg`, и при этом мобильный баннер «Продолжить в Telegram» НЕ показывается.

**Блок 3 — привязка и кабинет:**
10. На сайте в профиле нажми привязку Telegram → deep-link открывает бот → `/start link_*` →
    вернись на сайт: статус «привязано», вместо кнопки Telegram появился «Личный кабинет».
    *Это главный индикатор split-brain: если привязка «висит» — токен ушёл в Supabase (S-1).*
11. «Открыть приложение» в боте → Mini App `/cabinet`: каталог, реф-ссылка в главном меню.

**Блок 4 — деньги (главное):**
12. Кабинет или сайт → выбери сервис → тариф → экран заказа. Сверь цену:
    `курс Rapira × USD-цена + 30% + $4` (если активной карты нет). Курс должен быть живой,
    не `RATE_FALLBACK_USDT_RUB=81` — это заодно проверка контракта Rapira.
13. «Оплатить» → открывается ссылка L&P. Если вместо неё «технический сбой» — стоп, это
    провайдер/egress, зови меня.
14. Оплати. Ожидаемая цепочка в течение минуты: webhook L&P → заказ `paid` → `issue-card`
    (PaySpace) → реквизиты карты приходят в Telegram → `completed`.
15. Если реквизиты не пришли за 5 минут — не паникуй: `poll-payment` добирает раз в 5 мин.
    Приход после паузы = webhook не долетел (проверить URL webhook в кабинете L&P), но recovery жив.
16. Проверь в кабинете экран карты: live-баланс, «Для оплаты: <сервис>», «Действует до».

**Блок 5 — инфраструктура (можно параллельно):**
17. Cron: `ssh root@177.7.34.106 'grep CRON /var/log/syslog | tail -20'` — джобы идут.
    Ручной вызов: `curl -H "Authorization: Bearer $CRON_SECRET" https://new.oplatishka.com/api/cron/poll-payment`.
18. Rate-limit: `for i in $(seq 1 15); do curl -s -o /dev/null -w "%{http_code} " -X POST
    -H "x-real-ip: 10.0.0.$i" https://www.oplatishka.com/api/chat -d '{}'; done` — должны пойти 429.
    Подделка заголовка НЕ должна обнулять лимит.
19. Sentry: пока **не проверять** — он выключен (S-2). Сначала задать DSN.
20. Алёрты: `@oplatishkaAlert_bot` — прямые ops-DM живы, Sentry-rule алёрты мертвы (S-2).
