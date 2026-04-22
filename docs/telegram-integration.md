# Telegram интеграция

## Создание бота

1. Написать @BotFather, команда `/newbot`
2. Имя — любое (отображается пользователям)
3. Username — `oplati_podpicky_bot` (уникальный, заканчивается на `_bot`)
4. Получить токен → `TELEGRAM_BOT_TOKEN`
5. Настроить бота через @BotFather:
   - `/setdescription` — краткое описание
   - `/setabouttext` — текст в профиле бота
   - `/setuserpic` — аватарка
   - `/setcommands` — меню команд (см. ниже)

### Команды (через `/setcommands` у @BotFather)

```
start - Начать общение
help - Помощь и правила
orders - Мои заказы
operator - Связать с оператором
```

## Webhook

### Регистрация

После первого деплоя — выполнить один раз:

```bash
curl -F "url=https://oplati.example.com/api/bot" \
     -F "secret_token={{TELEGRAM_WEBHOOK_SECRET}}" \
     -F "drop_pending_updates=true" \
     -F "allowed_updates=[\"message\",\"callback_query\",\"edited_message\"]" \
     https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}/setWebhook
```

Проверка:
```bash
curl https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}/getWebhookInfo
```

`url` и `pending_update_count: 0` — webhook работает.

### Обработка в коде (специфика grammY)

- Использовать **webhook mode**, не long-polling. Long-polling несовместим с serverless
- Проверка `X-Telegram-Bot-Api-Secret-Token` обязательна — отказ с `401` если не совпадает
- В обработчике update — **не блокировать** webhook дольше 30 сек. Длинные операции (AI-вызов) делать inline (≤15 сек), а handoff/notification — через Trigger.dev event

### Формат сообщений

- **Plain text** по умолчанию. Markdown — только если бот сам его отправляет (`parse_mode: 'MarkdownV2'` с экранированием `_*[]()~\`>#+-=|{}.!`)
- Для кнопок — inline keyboards (`reply_markup.inline_keyboard`)
- Максимальная длина сообщения — 4096 символов; длинные ответы — разбивать

## Команда `/start`

1. Парсить deep-link payload: `/start ref_xxx` → сохранить в `users.notes` или отдельную таблицу (реф-программа backlog)
2. Если пользователь новый — создать `users(telegram_id, display_name, language)`, получить имя из `from.first_name + last_name`, язык из `from.language_code`
3. Создать или найти активный `conversations(user_id, channel='telegram', handoff_mode='ai')`
4. Отправить константу `GREETING` из `@oplati/agent`

## Обычное сообщение

1. Найти user по `telegram_id`
2. Найти или создать активный `conversations`
3. Если `handoff_mode === 'operator'` — **не звать AI**. Проксировать сообщение в форум-топик `telegram_topic_id` группы операторов
4. Иначе — сохранить сообщение в `messages(role='user')`, вызвать `runAgent()`, сохранить ответ, отправить пользователю

## Handoff оператору

### Предусловия

Создана Telegram-супергруппа операторов с включёнными форумами (Topics включаются в настройках группы → Topics). Бот добавлен админом с правами:
- Manage Topics
- Post Messages
- Delete Messages

ID группы — `TELEGRAM_OPERATORS_GROUP_ID` (начинается с `-100...`).

### Протокол handoff

Триггер: AI вызвал `request_human` или пользователь нажал кнопку/отправил команду `/operator`.

1. Сохранить событие в БД: `conversations.handoff_mode = 'operator'`, `order_events(event_type='handoff_requested')`
2. Публикация Trigger.dev event `handoff.requested` с `conversationId`
3. Worker `handoff-request`:
   - Создать topic в группе: `createForumTopic` API, name = `#<shortId> <display_name>`
   - Сохранить `conversations.telegram_topic_id`
   - Запостить в topic снапшот: карточка заказа (если есть) + последние 10 сообщений + причина handoff
   - Уведомить пользователя: «Оператор скоро подключится»

### Проксирование сообщений

**User → Operator group:**
Все входящие сообщения в личке (когда `handoff_mode='operator'`) копируются в topic через `sendMessage(chat_id=group, message_thread_id=topic_id, text=...)`.

**Operator → User:**
Сообщения в topic (кроме служебных) форвардятся пользователю. Фильтр:
- Игнорировать сообщения от других ботов
- Игнорировать команды (`/...`) — обрабатывать специально
- Поддерживать текст + фото (скриншоты) + документы

**Команды оператора в topic:**
- `/ai_back` — вернуть диалог AI (`handoff_mode='ai'`, закрыть topic)
- `/take` — оператор явно назначает себя (`conversations.assigned_operator_id`)
- `/note <text>` — приватная заметка, не отправляется клиенту
- `/order ORD-XXX` — отобразить карточку заказа в topic

### Attribution оператора

Operator в TG → `staff` запись ищется по `staff.telegram_id = update.from.id`. Если не найден — игнор + warn в Sentry.

## Ограничения Telegram API

- Rate limit: 30 сообщений/сек глобально, 1 сообщение/сек в chat
- При пакетной отправке использовать очередь с throttling
- При блокировке бота пользователем — ошибка 403; пометить `users.notes = 'blocked_bot'`, не пытаться слать снова

## Безопасность

- Webhook endpoint **всегда** отвечает `200 OK`, даже при внутренней ошибке (иначе Telegram будет ретраить и дублировать) — ошибки логируются в Sentry
- `X-Telegram-Bot-Api-Secret-Token` проверяется **первым**, до парсинга body
- Не доверять `from.language_code` — пользователь может его подменить; валидировать против whitelist (`ru`, `en`) с fallback `ru`
- PII в update — только необходимое (`id`, `first_name`). Не сохранять `username` без нужды

## Локальная разработка

1. Cloudflare Tunnel или ngrok:
   ```bash
   ngrok http 3000
   ```
2. Взять HTTPS URL → зарегистрировать как webhook
3. Создать **отдельного dev-бота** у @BotFather (не пересекаться с продом)
4. Хранить `TELEGRAM_BOT_TOKEN_DEV` отдельно от `TELEGRAM_BOT_TOKEN` (prod)
