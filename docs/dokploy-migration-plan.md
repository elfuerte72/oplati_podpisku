# ТЗ: переезд прода Vercel+Supabase → Hostinger VPS (Dokploy)

> Решение владельца 2026-07-24. Мотив: РФ-доступ без цепочки Timeweb-прокси и Vercel-костылей
> (System Bypass / SNI / alt-svc), экономия подписки, обучение self-host.
> VPS: Hostinger KVM 2, **US Boston 2**, `177.7.34.106` (Dokploy + Traefik уже стоят;
> там же Remnawave-панель (только control-plane, VPN-трафик на внешних нодах), squid `lnp-proxy`,
> портфолио, grafana-alloy → Loki, Beszel). После чистки n8n/Ollama: диск 39/96 ГБ, RAM 3.0/7.8.
>
> **Ключевой факт:** Supabase используется ТОЛЬКО как Postgres (postgres-js + Drizzle через
> `DATABASE_URL`; SDK `@supabase/supabase-js` в коде отсутствует, RLS-миграции — чистый SQL без
> `auth.*`). Мигрируем на **чистый `postgres:17`-контейнер**, НЕ self-hosted Supabase-стек.
>
> **Рабочая ветка:** `feat/dokploy-migration`. Прод (`main` → Vercel) не трогается до Фазы 4.
> Все изменения кода — инертные для Vercel (Dockerfile игнорируется, рантайм — за env-гейтами).
> Dokploy деплоит тестовый контур ПРЯМО с этой ветки.

Статусы: `[ ]` не начато · `[x]` готово · `[~]` в работе.

---

## Фаза 0 — подготовка (сделано 2026-07-24)

- [x] VPS почищен: n8n/Ollama удалены (контейнеры, volumes, образы) — освобождено ~15 ГБ.
- [x] Ветки репо вычищены (14 локальных + 13 remote, все squash-влиты; проверено `git cherry`).
- [x] Создана ветка `feat/dokploy-migration` от `main`.
- [x] Инвентаризация Vercel-зависимостей кода (см. Фазу 1 — список исчерпывающий).

## Фаза 1 — изменения кода (все — Vercel-инертные)

- [x] **1.1 `output: 'standalone'`** в `apps/web/next.config.ts`. На Vercel не влияет
      (Vercel собирает по-своему), для Docker — обязателен.
- [x] **1.2 `Dockerfile`** (корень репо) + **`.dockerignore`**. Multi-stage под
      pnpm+Turborepo-монорепо: `corepack enable` → install по lockfile →
      `pnpm --filter web build` → рантайм-слой из `.next/standalone` + `public` +
      `.next/static`. Node 24-slim, non-root user, `EXPOSE 3000`,
      `HEALTHCHECK` → `GET /api/health` (node fetch — curl в slim нет).
      Единственный `NEXT_PUBLIC_*` в проекте — `NEXT_PUBLIC_SENTRY_DSN` →
      build-arg. Проверено локальным билдом: образ 446 МБ, контейнер healthy.
- [x] **1.3 Self-call `payments/create`**: в `confirm-order.ts:129` цепочка
      `VERCEL_URL → APP_URL`. Добавлен приоритетный env `SELF_BASE_URL`
      (`http://127.0.0.1:3000` в контейнере): денежный self-call не выходит в интернет
      и не зависит от Traefik/DNS. Не задан → поведение прежнее (Vercel не затронут).
- [x] **1.4 `getClientIp` за Dokploy-Traefik** (`apps/web/lib/ratelimit.ts:87`).
      Сейчас приоритет — `x-real-ip` («Vercel проставляет сам»). За Traefik это
      **небезопасно**: Traefik по умолчанию НЕ затирает клиентский `X-Real-Ip` →
      подделка → обход rate-limit (тот же CWE-348, что уже дважды чинили).
      Добавить env-гейт `CLIENT_IP_MODE=traefik`: игнорировать `x-real-ip`, брать
      ПРАВЫЙ элемент `x-forwarded-for` (Traefik с дефолтным `forwardedHeaders`
      срезает входящие XFF и пишет реальный IP). Не задан → прежняя Vercel-логика.
      **Контракт Traefik НЕ выдумывать** — подтвердить живым вызовом на тестовом
      контуре (curl с поддельными `x-real-ip`/`x-forwarded-for` → лог фактических
      заголовков) и только потом закрепить. + unit-тест нового режима.
- [x] **1.5 `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` →
      `.optional()`** в `apps/web/lib/env.ts` (в рантайме не используются — только
      redact-лист логгера). Vercel-прод продолжает их задавать — ничего не ломается.
- [x] **1.6 Роли Postgres для чистого инстанса**: `packages/db/` — init-SQL
      (`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;`) — миграция `0010` делает
      `GRANT TO anon, authenticated` и упадёт без них. Оформить как idempotent
      pre-migrate скрипт (`db:init-roles`), НЕ как Drizzle-миграцию (на Supabase
      роли уже есть — конфликт).
- [x] **1.7 Crontab-манифест** `infra/crontab` (файл в репо → копируется на VPS в
      `/etc/cron.d/oplatishka`): 7 джобов из `vercel.json` (без `keepalive` — на
      чистом Postgres автопаузы нет) как `curl -fsS -H "Authorization: Bearer $CRON_SECRET"
      https://<домен>/api/cron/<job>`. Код cron-роутов НЕ меняется — авторизация
      уже совместима (`poll-payment/route.ts:43`).
- [ ] **1.8 Проверить, что НЕ требует правок** (зафиксировать в PR):
      `deployment-url.ts` — без `VERCEL_*` сам падает в `APP_URL` (корректно);
      `after()` из `next/server` — работает в self-hosted standalone (Next ≥15.1);
      `preferredRegion`/`maxDuration` экспорты — инертны вне Vercel;
      cron-роуты, webhook-роуты, Sentry, pino → stdout.
- [x] **1.9 `pnpm typecheck` + `pnpm --filter web test` + lint** зелёные; локальный
      `docker build` + запуск контейнера с dev-env — смоук `GET /api/health`.

## Фаза 2 — инфраструктура VPS/Dokploy (через Dokploy MCP + SSH)

- [x] **2.1 Postgres**: СДЕЛАНО 2026-07-24: сервис `oplatishka-db` (postgres:17,
      host в docker-сети `oplatishka-db-ry3smb`), внешний порт открывался только
      на время миграций и снят. Прогнано: db:init-roles -> db:migrate (17 таблиц,
      append-only триггер, RLS) -> db:seed (13 активных сервисов). Секреты
      контура — в `.env.dokploy-test.local` (gitignored).
- [ ] **2.2 Бэкапы с ПЕРВОГО дня** (учебная цель владельца): этап 1 — ежесуточный
      `pg_dump` → **off-site** (Cloudflare R2/B2, НЕ на сам VPS); этап 2 (до Фазы 4,
      пока клиентов нет — допустимо) — wal-g/pgBackRest, WAL-архив, PITR.
      **Правило: бэкап без проверенного restore — не бэкап** — восстановление
      прогнать руками минимум один раз до cutover.
- [x] **2.3 Dokploy-app** (СДЕЛАНО 2026-07-24: задеплоен, контейнер healthy, главная отдаёт каталог из нового Postgres; билд на VPS ~5 мин — риск R6 снят; ЖДЁТ: A-запись DNS от владельца) из GitHub-репо, ветка `feat/dokploy-migration`, build по
      Dockerfile, домен `new.oplatishka.com` (владелец: A-запись в CF DNS →
      `177.7.34.106`, серое облако), TLS — Traefik/ACME (уже выпускает для
      mxpkn8ns.ru).
- [x] **2.4 Env тестового контура** (СДЕЛАНО, кроме TELEGRAM_* — dev-токен добавит владелец) (канон списка — `apps/web/lib/env.ts`; значения —
      из локального `.env`/владельца, в Dokploy Secrets): dev-бот
      (`TELEGRAM_BOT_TOKEN`/`WEBHOOK_SECRET` dev-значения), `ANTHROPIC_MODEL` =
      Haiku, `APP_URL=https://new.oplatishka.com`, `SELF_BASE_URL=http://127.0.0.1:3000`,
      `CLIENT_IP_MODE=traefik`, `DATABASE_URL` → внутренний Postgres,
      отдельный `CRON_SECRET`/`INTERNAL_API_TOKEN`, `AI_DAILY_TOKEN_BUDGET=200000`.
      **`LOVEANDPAY_PROXY_URL` НЕ задавать**: egress-IP VPS = `177.7.34.106` = уже
      задекларирован у L&P → прямое соединение легально (squid остаётся только для
      Vercel-прода до cutover). **`PAYSPACE_*` НЕ задавать**: гейт
      `skipped_no_paypace` оставит тестовые заказы в `paid` — тест не выпускает
      реальные карты и не жжёт VCC-баланс.
- [ ] **2.5 Crontab на VPS** из `infra/crontab` (пока на тестовый домен).
- [x] **2.6 Логи** (alloy: discovery.docker "all" -> все контейнеры уже в Loki): проверить, что stdout контейнера попадает в grafana-alloy → Loki
      (label по имени сервиса); Sentry — отдельный `environment=dokploy-test`.

## Фаза 3 — обкатка тестового контура (критерии выхода)

- [ ] **3.1** Сайт открывается с РФ-SIM без VPN (владелец, мобильный оператор);
      TTFB сопоставим с Timeweb-цепочкой.
- [ ] **3.2** Dev-бот перерегистрирован на `new.oplatishka.com` (admin-endpoint
      `X-Internal-Token`); `/start`-меню, привязка веб↔Telegram (link-токены),
      `/support` — работают.
- [ ] **3.3** Кнопочный заказ → инвойс L&P создаётся НАПРЯМУЮ (без squid);
      webhook L&P продолжает бить в Vercel-прод (там `provider_ref` неизвестен →
      идемпотентный skip, это штатно) — тестовый контур добирает оплату через
      cron `poll-payment` ≤5 мин. Оплатить малый реальный счёт → заказ `paid` →
      `skipped_no_paypace`.
- [ ] **3.4** Подделка `x-real-ip`/`x-forwarded-for` НЕ обходит rate-limit
      (фиксация контракта Traefik из 1.4); rate-limit различает два разных IP.
- [ ] **3.5** Все 7 кронов отработали по расписанию (журнал + Loki), ручной вызов
      с `X-Cron-Token` работает.
- [ ] **3.6** Restore-учение: поднять БД из бэкапа 2.2 в чистый контейнер,
      приложение стартует на копии.
- [ ] **3.7** Мини-нагрузка (напр. `hey`/`ab` на каталог): p95, RAM контейнера —
      убедиться, что KVM 2 не упирается (Beszel).

## Фаза 4 — cutover прода (один вечер, при нуле клиентов риск ~0)

- [ ] **4.1** Merge `feat/dokploy-migration` → `main` (PR, зелёный CI). Vercel-прод
      от merge не меняет поведения (всё за env-гейтами).
- [ ] **4.2** Переключить Dokploy-app на ветку `main`; APP_URL → `https://www.oplatishka.com`.
- [ ] **4.3** Данные: `pg_dump` прод-Supabase → restore в VPS-Postgres.
      `pg_dump` переносит ВСЁ: строки, sequences, триггеры (append-only на
      `order_events`), RLS-политики — Drizzle-миграции при restore не гоняются
      (структура уже в дампе). Верификация — эталон ДО / сверка ПОСЛЕ:
      (а) точный `COUNT(*)` по всем 17 таблицам (снимок ~2026-07-24: messages 826,
      link_tokens 457, order_events 342, orders 133, conversations 131, users 75,
      payments 46, services 37, ai_usage_daily 11, cards 7, vpn_subscriptions 6,
      referral_accruals 5, остальные 0 — всего ~2000 строк, restore = секунды);
      (б) денежные контрольные суммы: `SUM(amount_rub)` payments,
      `SUM(original_amount)` orders, `SUM(amount_usd_cents)` referral_accruals;
      (в) последний `orders.ref` совпадает; (г) sequences не отстают (тестовый
      INSERT без конфликта id → откат); (д) смоук приложением: кабинет видит
      карту/данные на новой БД. Расхождение хоть в одной строке = стоп-фактор.
- [ ] **4.4** DNS: `www` + apex → A `177.7.34.106` (вместо Timeweb); Traefik/ACME
      выпускает сертификаты.
- [ ] **4.5** Прод-бот `@oplatishkaa_bot`: webhook → новый домен. L&P-webhook в
      кабинете → `www.oplatishka.com/api/payments/loveandpay`. Env прод-значения
      в Dokploy (боевой bot-token, Sonnet, `PAYSPACE_*` — с этого момента карты
      выпускаются здесь).
- [ ] **4.6** Боевой смоук: заказ → оплата → выпуск карты → реквизиты в Telegram →
      `completed`. Кроны переключены на www.
- [ ] **4.7** Откат (если что-то не так): DNS назад на Timeweb-цепочку + webhook'и
      назад — Vercel-прод жив до конца подписки, данные в Supabase не устарели
      (окно переключения ≈ минуты).

## Фаза 5 — после стабилизации

- [ ] **5.1** `MINIAPP_BASE_URL` убрать: кабинет с VPS доступен из РФ без VPN —
      отдельный vercel.app-домен больше не нужен. Владелец: Direct Link Web App URL
      в @BotFather → `https://www.oplatishka.com/cabinet`.
- [ ] **5.2** Better Stack: монитор на www (VPS) + `GET /api/health`.
- [ ] **5.3** Timeweb-прокси → холодный резерв (если `177.7.34.106` попадёт под
      ТСПУ); squid `lnp-proxy` можно погасить (egress теперь нативный).
- [ ] **5.4** Vercel: не продлевать подписку (дата окончания = дедлайн Фаз 1–4,
      не триггер). Supabase-прод не удалять минимум месяц (страховка данных).
- [ ] **5.5** Обновить `CLAUDE.md` (деплой/инварианты 9 про заголовки, env-таблицы),
      `docs/architecture.md`, `docs/monitoring.md`, `docs/CHANGELOG.md`.
- [ ] **5.6** (при появлении клиентов) Postgres → отдельный VPS (data-node,
      5432 только в приватной сети/WireGuard); при упоре в железо — апгрейд
      KVM 2→4 кнопкой в hPanel ($42.99/мес, односторонний).

## Риски / открытые вопросы

| # | Риск | Митигация |
|---|---|---|
| R1 | Контракт заголовков Traefik (X-Real-Ip/XFF) — предположение | 1.4/3.4: подтвердить живым вызовом ДО закрепления; не выдумывать контракт |
| R2 | Один VPS = один failure-domain (фронт+БД+панель) | Приемлемо при 0 клиентов; выход — 5.6 (data-node) + бэкапы 2.2 |
| R3 | `177.7.34.106` под ТСПУ в будущем | Timeweb-цепочка в холодном резерве (5.3); DNS-переключение — минуты |
| R4 | L&P-webhook общего аккаунта бьёт в прод во время тестов | Штатно: prod идемпотентно скипает чужой `provider_ref`; тест живёт poll'ом (3.3) |
| R5 | Sensitive-env не вытащить из Vercel (`env pull` пуст) | Значения — из локального `.env` + владелец; критичные (bot-token прод) вводит владелец в Dokploy UI |
| R6 | Билд монорепо в Docker тяжёлый для 2 vCPU | Собирать можно локально/в CI и пушить образ; для старта — билд на VPS ночью, замерить |
