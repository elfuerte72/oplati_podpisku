# Coding Standards

Правила для AI-агентов и людей, пишущих код в этом репо.

## Общая философия

1. **Сначала спецификация, потом код** — если поведение не описано в `docs/`, остановиться и задать вопрос, а не додумывать
2. **Zod на всех границах** — любой входящий JSON (webhook, request body, tool input) парсится через Zod
3. **Fail loudly** — ошибка лучше, чем тихий фоллбек. Не скрывать проблемы `try { } catch {}` без re-throw или явного логирования
4. **Читаемость > краткость** — явные имена лучше коротких

## TypeScript

### tsconfig

Корневой `tsconfig.base.json`:
- `"strict": true`
- `"noUncheckedIndexedAccess": true`
- `"noImplicitOverride": true`
- `"verbatimModuleSyntax": true`

### Типы

- **Никогда** `any`. Если действительно нужно — `unknown` + narrow через Zod
- **Никогда** `as T` без сильного обоснования в комменте. Вместо — Zod parse или user-defined type guard
- Интерфейсы для публичного API пакета; тип-алиасы для внутренних

### Null safety

- `null` и `undefined` различать осмысленно: `null` — явное отсутствие, `undefined` — не установлено
- В БД nullable поля — всегда явно в типе: `field: string | null`
- Не полагаться на truthy-checks (`if (order)`), проверять явно: `if (order !== null)`

### Imports

- Абсолютные импорты через alias (`@oplati/db`, `@/lib/...` в apps/web)
- Не импортировать приватные пути пакетов (`@oplati/db/src/schema`) — только barrel
- Группировать: сторонние → `@oplati/*` → локальные

## Error handling

### Классы ошибок

```typescript
// В @oplati/types
export class InvalidTransitionError extends Error { ... }
export class PaymentVerificationError extends Error { ... }
// и т.д.
```

Каждая ошибка имеет класс. Catch'и проверяют `instanceof`, не `err.message`.

### Правило «Never swallow»

```typescript
// ❌ Нельзя:
try { doThing(); } catch {}

// ❌ Нельзя:
try { doThing(); } catch (err) { console.log(err); }

// ✅ Можно:
try { doThing(); }
catch (err) {
  logger.error({ err }, 'failed to do thing');
  Sentry.captureException(err);
  throw err;  // или вернуть structured error
}
```

### Result pattern

Для ожидаемых «неудач» (невалидный webhook, просроченный order) — возвращать `{ ok: false, reason }` вместо throw. Throw — для неожиданных ошибок.

## Validation

### Zod everywhere

```typescript
// Request handler — сразу парсит body
const body = bodySchema.parse(await req.json());  // throws ZodError → 400
```

На каждом публичном endpoint — свой `*Schema` в `@oplati/types`.

### Не доверять ничему извне

- Webhook bodies
- Telegram updates (grammY уже валидирует, но ключевые поля ещё раз)
- AI tool inputs (Anthropic не гарантирует соответствие JSON Schema)
- URL params, cookies

## Naming

| Что | Пример |
|---|---|
| Переменные, функции | `camelCase` → `createOrder`, `userId` |
| Классы, типы | `PascalCase` → `OrderService`, `ToolHandlers` |
| Zod схемы | `camelCase` + `Schema` суффикс → `orderSchema`, `paymentWebhookEventSchema` |
| Константы времени компиляции | `UPPER_SNAKE_CASE` → `MAX_ITERATIONS`, `PAYMENT_TIMEOUT_MIN` |
| Таблицы, колонки БД | `snake_case` → `orders`, `assigned_operator_id` |
| Файлы | `kebab-case.ts` или `PascalCase.tsx` для компонентов |
| Events (Trigger.dev, внутренние) | `dot.separated` → `order.status_changed`, `handoff.requested` |
| URL paths | `/kebab-case` → `/api/payments/yookassa` |

Имена должны быть **понятны без контекста**. Не `mgr`, `svc`, `hdlr` — писать полностью.

## React / UI

- **RSC по умолчанию**. `"use client"` только там, где нужен браузерный API/интерактив
- Server actions — для мутаций из UI
- `<Suspense>` + loading.tsx — стандарт App Router
- Состояние: предпочитать server state (RSC + revalidate) + Supabase Realtime. Клиентский state — только UI (открыт/закрыт)
- Формы: React Hook Form + Zod resolver

## Тесты

### Юнит-тесты (Vitest)

Обязательны для:
- `@oplati/types` — `canTransition` (все переходы в таблице)
- `@oplati/agent` — парсинг tool inputs, базовый цикл агента (с мок-клиентом Anthropic)
- Payments adapters — парсинг webhook payloads на fixtures
- `transitionOrder` — валидные/невалидные переходы, side effects

### Integration

Минимально на MVP. В Sprint 3:
- End-to-end сценарий заказа (моковые провайдеры)
- Admin RLS политики (через Supabase client с auth)

### Структура

```
packages/db/
├── src/
│   └── schema.ts
└── __tests__/
    └── schema.test.ts
```

## Git & Commits

### Branches

- `main` — production
- `dev` — интеграционная (если нужна), либо работа в feature-ветках от main
- `feat/*`, `fix/*`, `chore/*`, `docs/*` — feature-ветки

### Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(agent): add request_human tool
fix(payments): handle YooKassa idempotence duplicate correctly
docs(database): clarify RLS for order_events
chore(deps): bump drizzle-orm to 0.36
refactor(web): move handoff logic to trigger task
```

- Заголовок ≤ 72 символа
- Present tense, imperative («add», не «added»)
- Body — опционально, для сложных PR

### PR

- Каждый PR имеет Definition of Done (см. roadmap)
- PR description: что сделано, как протестировано, ссылка на issue/spec
- Не мерджить без типчек + lint зелёных
- Squash merge — один коммит на PR

## Комментарии в коде

- Комментируй **«почему»**, а не «что» — код сам должен быть читаем
- TODO-комментарии — с именем и датой: `// TODO(penkin, 2026-04-22): ...`
- Нельзя оставлять «закомментированный код» — удалять, git помнит

## Что запрещено

- `console.log` в production-коде — только `logger.*`
- Hardcoded values там, где должна быть env variable
- `fetch` без timeout — всегда `AbortController` или wrapper
- Синхронный fs в hot path
- Mutation глобального state
- Эмодзи в коде, комментариях, логах (можно только в UI-строках на русском, если того требует продукт)
