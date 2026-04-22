# Документация проекта «Оплати подписки»

Проект: Telegram-бот + веб-чат для продажи иностранных подписок русскоязычным пользователям. Оплата рублями/криптой, исполнение — ручное командой операторов 24/7.

Документация написана как **спецификация для реализации**. AI-агенты Claude Code должны читать её как источник правды при написании кода.

## Навигация

### Продукт
- [PRD.md](PRD.md) — продуктовые требования, цели, метрики
- [glossary.md](glossary.md) — термины и сокращения
- [roadmap.md](roadmap.md) — 3 спринта с Definition of Done

### Архитектура
- [architecture.md](architecture.md) — высокоуровневая архитектура, потоки данных, границы
- [tech-stack.md](tech-stack.md) — стек с версиями и обоснованиями
- [repo-structure.md](repo-structure.md) — структура монорепы, правила зависимостей пакетов

### Данные и логика
- [database.md](database.md) — схема БД, индексы, RLS, инварианты
- [state-machine.md](state-machine.md) — жизненный цикл заказа
- [ai-agent.md](ai-agent.md) — поведение AI, системный промпт, инструменты

### Интеграции
- [api.md](api.md) — спецификация всех HTTP endpoints
- [telegram-integration.md](telegram-integration.md) — бот, webhook, команды, handoff операторам
- [web-chat.md](web-chat.md) — веб-чат, идентификация, anti-abuse
- [payments.md](payments.md) — YooKassa, CryptoBot, идемпотентность, reconciliation
- [supabase-setup.md](supabase-setup.md) — создание проекта, Storage, Auth, RLS
- [background-jobs.md](background-jobs.md) — Trigger.dev задачи, cron

### Операции и качество
- [security.md](security.md) — threat model, secrets, HMAC, rate limit
- [observability.md](observability.md) — Sentry, логи, алерты
- [coding-standards.md](coding-standards.md) — конвенции кода для AI-агентов
- [env-vars.md](env-vars.md) — все переменные окружения
- [deployment.md](deployment.md) — Vercel, домены, регионы, окружения
- [operator-runbook.md](operator-runbook.md) — playbook для операторов и супервизоров
- [dev-setup.md](dev-setup.md) — локальная настройка

## Как читать эту документацию

1. Начать с `PRD.md` и `architecture.md` — общий контекст
2. Для конкретной задачи — профильный документ (например, `payments.md` для интеграции YooKassa)
3. `coding-standards.md` — прочитать **перед первым коммитом**
4. При возникновении неопределённости — спросить владельца проекта, **не** додумывать

## Источник правды

При конфликте между документацией и кодом — **правда в документации**, код нужно привести в соответствие. Исключение: если расхождение явно зафиксировано в ADR (architecture decision record) позже даты документа.
