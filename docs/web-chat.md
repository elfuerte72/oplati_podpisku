# Веб-чат

Резервный канал на случай блокировок Telegram. Живёт по адресу `/chat` в `apps/web`. Использует ту же AI-логику, что и Telegram-бот.

## UI требования

Минималистичный чат-интерфейс:
- Шапка: название сервиса + статус (online/waiting operator)
- Область сообщений (скролл, auto-scroll на новые)
- Поле ввода + кнопка «Отправить»
- Кнопка «Позвать оператора» (всегда доступна)
- Индикатор typing при стриминге ответа AI

**Стиль:** shadcn/ui + Tailwind. Тёмная тема по умолчанию (люди общаются с ботом часто в тёмное время).

**Адаптивность:** mobile-first. На мобильных — полная высота viewport.

**Без Markdown рендера** для сообщений от AI — только текст с переносами строк и ссылками (auto-linkify `https://...`).

## Идентификация пользователя

Веб-юзер идентифицируется через **httpOnly cookie** `session`:
- При первом визите — генерировать `web_session_id` = UUID v4, выставить cookie с `SameSite=Lax`, `Secure`, `HttpOnly`, срок 180 дней
- Создать запись `users(web_session_id)` при первом сообщении, не при открытии страницы

### Подтверждение личности (Sprint 3)

Для заказов с KYC или суммой >5000 ₽ — запросить email или phone с кодом подтверждения (6 цифр, SMS/email).
- Провайдер SMS: Twilio / SendPulse (выбор — позже)
- Провайдер email: Resend / Postmark
- Код хранится в Redis (Upstash) 10 минут

### Связывание с Telegram-аккаунтом

Пользователь, зашедший в веб-чат, может связать свой Telegram:
- В TG-боте команда `/link_web` → генерирует одноразовый токен (6 символов) на 10 минут
- В веб-чате — ввод токена → обновление `users.telegram_id` в записи веб-сессии
- Либо наоборот: в вебе «Связать Telegram» → deep-link `https://t.me/bot?start=link_{{token}}`

После связывания — одна запись `users` с обоими `telegram_id` и `web_session_id`.

## Стриминг (технически)

**Endpoint:** `POST /api/chat` возвращает `text/event-stream`.

**Client:** `useChat()` из `ai/react` (Vercel AI SDK):

```typescript
// Описание поведения, реализация по стандартным паттернам AI SDK
const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
  api: '/api/chat',
});
```

**Server:** использовать `streamText` из `ai` package с провайдером `@ai-sdk/anthropic`. Привязать тот же системный промпт и те же tools, что в Telegram-боте (через `@oplati/agent`).

**Tool calls в UI:** AI SDK рендерит tool invocations через `message.toolInvocations`. Для нашего UI — показывать человекочитаемый статус:
- `search_catalog` → «Смотрю каталог…»
- `propose_order` → карточка заказа с кнопкой «Подтвердить»
- `confirm_order` → блок с платёжной ссылкой
- `request_human` → «Зову оператора…» и далее смена состояния

## Anti-abuse

### Rate limit

Upstash Ratelimit на `web_session_id`:
- 20 сообщений / 5 минут — warn
- 60 сообщений / 5 минут — block на 15 минут, сообщение «Слишком много запросов»
- 200 сообщений / час — flag в БД для ручного разбора

### BotID / Turnstile

В Sprint 3 добавить Cloudflare Turnstile (или Vercel BotID) на первое сообщение в сессии:
- Невидимый challenge
- При подозрении — явный CAPTCHA

### Фильтрация ввода

- Максимальная длина сообщения — 4000 символов
- Отклонять сообщения с подозрением на prompt injection (простая эвристика: детект триггер-фраз вроде «ignore previous instructions», «system:», «You are now»)
- При detection — не передавать AI, отвечать нейтральной фразой + флаг в БД

## Состояния диалога

| Состояние | UI | Поведение |
|---|---|---|
| Новая сессия | Приветствие AI + placeholder в input | — |
| AI думает (стрим) | Typing indicator | — |
| AI ответил | Сообщение + auto-scroll | — |
| Ошибка (Anthropic down) | Баннер «Технические проблемы. Попробуйте через минуту» | Retry при следующем сообщении |
| Handoff активен | Баннер «Оператор подключён», input работает, но сообщения идут оператору | AI не отвечает |
| Rate limited | Блок на ввод + таймер | — |

## Оффлайн и ошибки

- Если WebSocket/SSE теряется — реконнект автоматически
- Если пользователь отправляет при потерянном соединении — queue в localStorage, резенд при восстановлении
- При 429 — показать понятную ошибку, не прятать

## SEO и доступность

- `/chat` — `robots: noindex` (не индексировать)
- `/` (лендинг) — SEO-friendly, SSR
- Aria-labels на кнопках и инпуте
- Keyboard navigation: Enter для отправки, Shift+Enter для переноса

## Что запрещено

- Класть `SUPABASE_SERVICE_ROLE_KEY` или `ANTHROPIC_API_KEY` в клиентский код — API-вызовы всегда через server route
- Хранить историю сообщений в localStorage — источник правды БД
- Отправлять сообщение в клиент до подтверждения сохранения в `messages` — потеря данных при дисконнекте
