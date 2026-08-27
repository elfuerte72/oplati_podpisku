# Оплати подписки

Telegram-бот + сайт + Mini App-кабинет для оплаты иностранных подписок русскоязычными
пользователями: клиент платит рубли (СБП/карта), мы выпускаем ему виртуальную USD-карту,
которой он платит на сайте сервиса. Плюс внутренняя админ-панель для владельца и менеджеров.

**Источник правды — код + [`CLAUDE.md`](CLAUDE.md)** (инварианты, что работает сейчас, что
запрещено). Карта всей документации — [`docs/README.md`](docs/README.md); устройство
кодовой базы — [`docs/architecture.md`](docs/architecture.md).

## Стек

TypeScript 5.6 · Node.js 24 · pnpm + Turborepo · Next.js 16 (App Router) · grammY ·
`@anthropic-ai/sdk` (свой tool-loop, `claude-sonnet-4-6`) · self-hosted Postgres 17 + Drizzle ·
Zod · Tailwind v4 · Sentry + pino · Vitest (интеграционные тесты БД — на PGlite) ·
**Dokploy на VPS** (Docker + Traefik) + системный crontab.

Осознанно НЕ используем: Vercel AI SDK и стриминг, Trigger.dev, shadcn/ui, Supabase-SDK
(с Supabase и Vercel переехали 2026-07-24 — история в `docs/history/`).

## Что где

```
apps/web/          Next.js: сайт (веб-чат), Telegram-бот (/api/bot), Mini App (/cabinet),
                   админ-панель (/admin, домен admin.oplatishka.com), API, cron-эндпоинты
packages/types/    Zod-схемы всех границ + state machine заказа (источник контрактов)
packages/db/       Drizzle: schema.ts (21 таблица, RLS везде), repositories/, migrations/
packages/agent/    AI-агент «Оплатишка» (runAgent, промпты, tools); БД не импортирует
infra/             crontab.example, шаблоны Traefik, Alloy (логи в Grafana Cloud)
docs/              документация: архитектура, BACKLOG, CHANGELOG, инциденты, рунбуки, справочники
```

Полная раскладка с назначением каждого модуля — `docs/architecture.md`, раздел
«Файловая система: кто за что отвечает».

## Запуск локально

```bash
pnpm install
# создать apps/web/.env.local — список переменных: docs/reference/env-vars.md
pnpm dev                                        # turbo dev → http://localhost:3000
pnpm typecheck && pnpm -r --if-present test && pnpm lint
```

Боевые ключи (Freekassa, Love&Pay, PaySpace), прод-бот и прод-БД для локальной
разработки не используются — для проверок есть dev-стенд `dev.oplatishka.com`
(Basic Auth) с dev-ботом и dev-БД без клиентских данных.

## Деплой

Только через `.github/workflows/deploy.yml`: push в `main` (прод, `www.oplatishka.com`)
или `dev` → гейт typecheck + тесты + lint + build → deploy-вебхук Dokploy → проверка, что
контейнер реально обновился (`startedAt` из `/api/health`) → `/api/ready` сверяет журнал
миграций. **Деплой миграции НЕ применяет** — после мержа с миграцией её применяют на
прод-БД руками (скилл `deploy-and-migrations`, рунбук `docs/runbooks/deploy.md`).
Прямой push в `main` закрыт ruleset'ом, мерж — squash.

## Правила, которые нарушают чаще всего

- `order_events` — append-only; статус заказа меняется только через `transitionOrder()`.
- Деньги — integer в минимальных единицах (копейки, USD-центы); Zod на всех границах.
- Webhook-эндпоинты всегда отвечают `200` (кроме `/api/bot` и `/api/staff-bot` → `401` при
  неверном secret-token).
- Границы пакетов строгие: `@oplati/agent` не импортирует `@oplati/db`; никаких
  кросс-импортов между `apps/*` и приватных путей пакетов.
- Полные PAN/CVC карт никогда не логируются и не сохраняются.

Остальное — в `CLAUDE.md`.
