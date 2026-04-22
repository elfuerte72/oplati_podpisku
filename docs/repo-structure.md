# Структура репозитория

Монорепа на Turborepo + pnpm workspaces. Modular monolith: один деплой, чёткие границы пакетов.

## Дерево

```
oplati_podpicky/
├── .github/
│   └── workflows/              GitHub Actions: typecheck + lint на PR
├── apps/
│   └── web/                    Next.js 16 App Router — единый деплой
│       ├── app/
│       │   ├── (marketing)/    публичные страницы
│       │   │   └── page.tsx        лендинг
│       │   ├── chat/
│       │   │   └── page.tsx        веб-чат (useChat)
│       │   ├── admin/
│       │   │   ├── layout.tsx      защищён Supabase Auth
│       │   │   ├── page.tsx        дашборд (метрики)
│       │   │   ├── orders/         список + карточка
│       │   │   └── catalog/        управление каталогом
│       │   └── api/
│       │       ├── bot/route.ts             Telegram webhook
│       │       ├── chat/route.ts            AI streaming (SSE)
│       │       ├── payments/
│       │       │   ├── yookassa/route.ts    webhook YooKassa
│       │       │   └── cryptobot/route.ts   webhook CryptoBot
│       │       └── trigger/[...trigger]/    Trigger.dev ingest
│       ├── lib/
│       │   ├── supabase/       браузерный и серверный клиент
│       │   ├── sentry.ts       инициализация
│       │   └── tool-handlers/  реализации ToolHandlers из agent
│       ├── components/         shadcn/ui + свои
│       ├── next.config.ts
│       └── sentry.*.config.ts
├── packages/
│   ├── agent/                  AI-агент, промпты, схемы tools
│   ├── db/                     Drizzle schema + repositories + migrations
│   ├── types/                  Zod-контракты (источник правды)
│   └── ui/                     (опционально во 2 спринте) shared UI
├── docs/                       вся спецификация проекта
├── package.json                корневой, со scripts turbo
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── .env.example
└── .gitignore
```

## Границы пакетов (строгие)

| Пакет | Может импортировать | Не может импортировать |
|---|---|---|
| `@oplati/types` | ничего (только `zod`) | `@oplati/*` |
| `@oplati/db` | `@oplati/types` | `@oplati/agent`, `apps/web` |
| `@oplati/agent` | `@oplati/types` | `@oplati/db` **напрямую** |
| `@oplati/ui` | `@oplati/types` | `@oplati/db`, `@oplati/agent` |
| `apps/web` | все `@oplati/*` | — |

**Почему `agent` не импортирует `db`:** инструменты AI (tools) должны быть подставляемыми извне. Это позволяет (а) мокать их в тестах, (б) вынести `agent` в отдельный сервис без переписывания.

Связка делается через интерфейс `ToolHandlers`, определённый в `@oplati/agent`. Реализация живёт в `apps/web/lib/tool-handlers/`.

## Именование

### Файлы
- React-компоненты: `PascalCase.tsx`
- Утилиты, хуки, routes: `kebab-case.ts`
- Типы и интерфейсы: внутри модуля либо в `types.ts`

### Экспорты
- Каждый пакет имеет один публичный `index.ts` (barrel)
- Всё, что не в barrel, — приватное для пакета
- Не использовать `export default` в библиотечных пакетах (`@oplati/*`), только named exports

### Identifier'ы
- Функции и методы: `camelCase`
- Классы, типы, интерфейсы, enum-значения: `PascalCase`
- Константы: `UPPER_SNAKE_CASE` **только** для реально констант времени компиляции
- Таблицы БД: `snake_case`, множественное число (`orders`, `order_events`)

## Workspace-команды

Из корня:
```bash
pnpm dev                            # все пакеты в watch
pnpm build                          # production build
pnpm typecheck                      # tsc --noEmit во всех пакетах
pnpm lint                           # eslint
pnpm --filter @oplati/db db:push    # применить миграции
pnpm --filter web dev               # только Next.js
```

## Запрещено

- Кросс-импорты между `apps/*` — приложение изолировано
- Циклические зависимости между пакетами
- Импортировать приватные пути (`@oplati/db/src/schema` минуя barrel) — только публичный `@oplati/db`
- `../../../` cross-package imports
