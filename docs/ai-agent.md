# AI-агент

Единый AI-консультант обслуживает **оба канала** (Telegram + веб-чат). Модель: **Claude Opus 4.6** через `@anthropic-ai/sdk` для Telegram и через Vercel AI SDK для стриминга в веб.

## Принципы поведения

1. **Как живой человек** — без канцелярита, без маркетинговых клише, без перегруженности эмодзи
2. **Не обещать неизвестного** — если не уверен, либо уточняй, либо зови оператора
3. **Никогда не придумывать цены** — только через `search_catalog` или фиксированные в `propose_order`
4. **Не обсуждать серые схемы, политику, обход санкций**
5. **Не просить и не хранить** пароли, 2FA-коды, номера карт
6. **Не давать юридических советов**

## Системный промпт (источник правды)

```
Ты — консультант сервиса «Оплати подписки». Помогаешь русскоязычным пользователям оплачивать иностранные сервисы (Claude, ChatGPT, Netflix, Spotify, Airbnb, YouTube Premium и др.), которые нельзя оплатить рублями напрямую.

КАК ОБЩАТЬСЯ
- Пиши как живой человек: коротко, по делу, на «ты» если пользователь так обратился первым, иначе на «вы».
- Не используй канцелярит и маркетинговые клише. Никаких «С удовольствием помогу!», «Отлично!» в каждом сообщении.
- Одно сообщение = одна мысль. Длинные объяснения разбивай.
- Эмодзи — максимум одно на сообщение и только когда реально уместно.
- Не обещай того, чего не знаешь. Если не уверен — так и скажи и предложи подключить оператора.

ЧТО ТЫ ДЕЛАЕШЬ
1. Выясняешь, какой сервис нужен и какой тариф/период.
2. Уточняешь детали: email аккаунта в сервисе, регион если важен, нужны ли особые параметры.
3. Проверяешь, нужен ли KYC (например, Airbnb, LinkedIn, некоторые банковские сервисы — да; Claude, Spotify, Netflix — обычно нет). Если нужен — честно предупреди и объясни, что потребуется.
4. Озвучиваешь итоговую цену в рублях (она включает услугу оплаты).
5. Когда всё ясно — через инструмент propose_order формируешь заказ и показываешь сводку пользователю на подтверждение.
6. После подтверждения — через confirm_order запускаешь оплату и даёшь ссылку.

КОГДА ЗВАТЬ ОПЕРАТОРА (request_human)
- Пользователь сам попросил.
- Сложный KYC-кейс, неочевидные требования сервиса.
- Проблема с платежом, возврат, спор.
- Что-то вне твоей компетенции.

ЧЕГО НЕ ДЕЛАЕШЬ
- Не обсуждаешь обход санкций, политику, серые схемы.
- Не даёшь юридических консультаций.
- Не храни и не проси передать тебе пароли, коды 2FA, номера карт.
- Не придумываешь цены — бери только через search_catalog или propose_order.

ФОРМАТ
- Никакого Markdown в Telegram, если не уверен что он рендерится.
- Для списков — дефисы и переносы строки.
- Длинные цены и условия — в отдельном сообщении.
```

Промпт должен храниться как константа в `@oplati/agent/src/prompts.ts`. Любые изменения — через PR с обоснованием в коммит-сообщении.

## Инструменты (tools)

Агент имеет 4 инструмента. Имена и JSON Schema фиксированы — менять только вместе с тест-сьютом.

### `search_catalog`

Найти сервисы в каталоге по ключевому слову или категории.

**Input:**
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "category": {
      "type": "string",
      "enum": ["ai", "streaming", "travel", "productivity", "other"]
    }
  },
  "required": ["query"]
}
```

**Output (что возвращает handler):**
```json
{
  "services": [
    {
      "slug": "claude-pro",
      "name": "Claude Pro",
      "category": "ai",
      "requiresKyc": false,
      "tiers": [
        { "name": "Pro", "period": "month", "priceRub": 249900 }
      ]
    }
  ]
}
```

Цены — в копейках. AI должен форматировать их в рублях для пользователя («2 499 ₽ в месяц»).

### `propose_order`

Сформировать черновик заказа.

**Input:**
```json
{
  "type": "object",
  "properties": {
    "serviceSlug": { "type": "string" },
    "customDescription": { "type": "string" },
    "tierName": { "type": "string" },
    "period": { "type": "string", "enum": ["month", "year"] },
    "accountEmail": { "type": "string" },
    "notes": { "type": "string" }
  }
}
```

Либо `serviceSlug`, либо `customDescription` — обязательно одно из двух.

**Output:**
```json
{
  "orderId": "uuid",
  "shortId": "ORD-7KX42",
  "amountRub": 249900,
  "summary": "Claude Pro, 1 месяц, email: user@example.com",
  "requiresKyc": false,
  "kycInstructions": null
}
```

Handler создаёт `orders(status='draft')`, сразу переводит в `clarifying` или `ready_for_payment` в зависимости от полноты данных.

### `confirm_order`

Подтвердить заказ после явного «да» от пользователя — создать платёжную ссылку.

**Input:**
```json
{
  "type": "object",
  "properties": {
    "orderId": { "type": "string" },
    "paymentMethod": {
      "type": "string",
      "enum": ["yookassa", "sbp", "cryptobot"]
    }
  },
  "required": ["orderId", "paymentMethod"]
}
```

**Output:**
```json
{
  "paymentUrl": "https://yookassa.ru/...",
  "expiresAt": "2026-04-22T18:30:00Z",
  "orderId": "uuid"
}
```

Handler:
1. Проверяет что заказ в статусе `ready_for_payment`
2. Создаёт платёж у провайдера
3. Переводит заказ в `pending_payment`
4. Возвращает URL

### `request_human`

Передать разговор оператору.

**Input:**
```json
{
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "enum": ["user_requested", "ai_uncertain", "kyc_complex", "payment_issue", "dispute", "other"]
    },
    "context": { "type": "string" }
  },
  "required": ["reason", "context"]
}
```

**Output:**
```json
{
  "handedOff": true,
  "estimatedWaitMinutes": 5
}
```

Handler:
1. Устанавливает `conversations.handoff_mode = 'operator'`
2. Публикует событие `handoff-request` в Trigger.dev
3. Worker создаёт topic в Telegram-группе операторов со снимком контекста
4. AI прекращает отвечать; дальше — только оператор

## ToolHandlers contract

В `@oplati/agent` **не** реализуются handlers — только их интерфейс:

```typescript
export interface ToolHandlers {
  search_catalog: (input: SearchCatalogInput) => Promise<SearchCatalogOutput>;
  propose_order: (input: ProposeOrderInput) => Promise<ProposeOrderOutput>;
  confirm_order: (input: ConfirmOrderInput) => Promise<ConfirmOrderOutput>;
  request_human: (input: RequestHumanInput) => Promise<RequestHumanOutput>;
}
```

Реализации — в `apps/web/lib/tool-handlers/`. Каждая реализация:
- Валидирует input через Zod на входе (Anthropic не гарантирует соответствие JSON Schema)
- Ловит все ошибки, возвращает `{ error: "..." }` вместо throw — агент должен получить результат, чтобы ответить пользователю осмысленно
- Логирует (Sentry breadcrumb) с `orderId`/`conversationId`

## Агентский цикл

```
1. Получить сообщение пользователя
2. Загрузить историю conversation (последние 50 сообщений или 10k токенов)
3. Собрать messages = [...history, { role: 'user', content: новое_сообщение }]
4. Вызвать Claude с system + tools + messages
5. Если stop_reason === 'tool_use':
     - для каждого tool_use вызвать соответствующий handler
     - добавить tool_result в messages
     - GOTO 4 (максимум 5 итераций)
6. Если stop_reason === 'end_turn':
     - сохранить ответ в messages
     - вернуть текст пользователю
```

**Лимит итераций:** 5. При превышении — throw и `request_human(reason: 'ai_uncertain')`.

## Контекстное окно

- Хранить все сообщения в БД
- В промпт Claude подавать **скользящее окно**: последние N сообщений до ~10k токенов контекста
- При превышении — обрезать старые, но сохранить системный промпт и любые уже начатые tool-вызовы
- На будущее: conversation summary через отдельный суммаризатор (не на MVP)

## Обработка ошибок

| Ситуация | Поведение |
|---|---|
| Anthropic API timeout | retry с backoff (max 2 попытки), затем сообщение «Небольшая задержка, попробуйте ещё раз через минуту» |
| Rate limit (429) | expose `Retry-After`, обработать тихо |
| Invalid tool input | handler возвращает `{ error }`, агент объясняет пользователю |
| Превышен лимит итераций | `request_human('ai_uncertain')` |
| Claude генерирует фейковую цену | **ловить в unit-тестах** через моки search_catalog; при обнаружении в проде — в Sentry breadcrumb, временное отключение AI canal + алерт |

## Эволюция промпта

- Изменения — через PR с A/B тестом (если возможно) или ручной проверкой на 10 сценариях из `docs/fixtures/conversations.json` (создать по мере накопления реальных диалогов)
- Версионирование промпта: `meta.promptVersion` в messages для трассируемости

## Мониторинг качества диалогов

- Sentry breadcrumb'ы на каждом tool-call
- Отдельный лог-канал `ai-conversations` в Logtail (структурированные JSON)
- Супервизор в админке может флагировать диалог (`conversations.flagged = true`) для review
