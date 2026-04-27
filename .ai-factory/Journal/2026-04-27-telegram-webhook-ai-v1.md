# 2026-04-27 — Telegram webhook + AI v1

Реализован milestone «Telegram webhook + AI v1» из `.ai-factory/ROADMAP.md`. Бот отвечает на `/start` приветствием и на любой текст — ответом Claude (Opus 4.6) без tools.

## Решения

- **Stateless round-trip.** История диалога не хранится — появится в следующем milestone, когда поднимем `users/conversations/messages` через Drizzle. На serverless cold-start in-memory cache бесполезен, а городить Redis ради одной фичи дороже, чем подождать БД.
- **`runAgentNoTools()` отдельной функцией** в `@oplati/agent`, а не if-веткой в `runAgent()`. `runAgent()` должна оставаться путём «AI с tools» под Sprint 2; смешивать ветки сейчас — дольше распутывать потом.
- **Node runtime, не Edge** — pino требует Node API; `runtime = 'nodejs'` явно прописан в route.
- **grammY как HTTP-клиент.** Используем только `bot.api.sendMessage`, диспатч updates руками. На таком узком наборе кейсов (`/start` + free text) полный grammY-роутинг даёт overhead.
- **`telegramUpdateSchema` в `@oplati/types`** — минимальный slice (`update_id`, `message.{message_id, chat, from?, text?}`); только `zod`. Никакого `@types/telegram-bot-api` — мы валидируем свою границу, не реплицируем чужой контракт.
- **Webhook всегда `200 OK`**, кроме невалидного `X-Telegram-Bot-Api-Secret-Token` (`401`). Иначе Telegram ретраит и забивает очередь — это ровно тот патч, что хочется не получать.
- **`parse_mode` не используем** (plain text) — экранирование `MarkdownV2` без явной нужды добавляет источник ошибок; включим, когда будет inline keyboard и заказы.

## Smoke (manual)

```bash
# 1. dev-бот через @BotFather, токен в apps/web/.env.local как TELEGRAM_BOT_TOKEN
# 2. секрет:
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)

# 3. поднимаем dev:
pnpm --filter web dev
# в другом терминале:
ngrok http 3000

# 4. регистрируем webhook (URL из ngrok):
curl -F "url=$NGROK_URL/api/bot" \
     -F "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
     -F "drop_pending_updates=true" \
     -F 'allowed_updates=["message"]' \
     "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook"

# 5. проверяем:
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
# pending_update_count: 0, last_error_message: ""
```

Ожидание:
- `/start` → `GREETING` из `@oplati/agent`.
- «Хочу Claude Pro» → AI отвечает по `SYSTEM_PROMPT` (без вызова tools — их и не передаём).
- Запрос с неверным `X-Telegram-Bot-Api-Secret-Token` → `401` (видно в ngrok / Vercel logs).
- В логах: `telegram.webhook.received` → `telegram.message.user` → `telegram.message.ai_reply` (`durationMs`, `totalTokens`, `replyLength`). Сами тексты сообщений в логи НЕ попадают (`*.text` редактируется в `lib/logger.ts`).

## Smoke-результаты (фактический прогон)

Прогнали 2026-04-27 через `serveo.net` SSH-туннель (cloudflared/localtunnel заблокированы локальным VPN-клиентом — TUN-режим перехватывает DNS/HTTP, ssh:22 проходит).

Зафиксировано в логах:
- **`GET /api/health` через туннель** → 200, `{"status":"ok"}` — туннель и сервер живые.
- **`POST /api/bot` с заведомо неверным `X-Telegram-Bot-Api-Secret-Token`** → 401, log `telegram.webhook.unauthorized` (single non-200 case по контракту).
- **`POST /api/bot` с валидным секретом + update без `message.text`** → 200, log `telegram.update.ignored { kind: "no_text" }` (4ms application-code).
- **`/start` от реального пользователя** через Telegram → 200 в 1011ms (включая lazy-init `Bot` singleton при первом hit'е), log: `telegram.webhook.received` → `telegram.start { chatId, telegramUserId, languageCode: "ru" }` → `telegram.bot.initialized`. Бот ответил `GREETING`.
- **4 свободных сообщения от реального пользователя → AI-ответы** (Claude **Haiku 4.5** через `runAgentNoTools`, не Opus — Opus здесь дороже на порядок и не требуется для болтовни консультанта):

  | # | end-to-end | application-code | inputTokens | outputTokens | totalTokens | replyLength |
  |---|---|---|---|---|---|---|
  | 1 | 3.4s | 3.2s (incl Bot init) | — | — | — | — |
  | 2 | 4.7s | 4.7s | 849 | 98 | 947 | 220 |
  | 3 | 4.7s | 4.7s | 861 | 138 | 999 | 313 |
  | 4 | 3.1s | 3.1s | 861 | 87 | 948 | 193 |

  Стабильная картина: **2.3–4.5 сек** до Anthropic + Telegram-send, ~950–1000 total tokens на сообщение (input ~850 — это `SYSTEM_PROMPT` + само сообщение, output ~90–140). next.js overhead 3–5мс после первого hit'а. Никаких unhandled rejection / Sentry-warn / `telegram.send.*_error`.
- **`getWebhookInfo`** до и после: `pending_update_count: 0`, `last_error_message` пустой.

PII-проверка по логам: текстов сообщений нет, только метаданные (`chatId`, `telegramUserId`, `textLength`, `durationMs`) — `*.text` редактируется на уровне pino.

После прогона: `deleteWebhook` → 200 (чтобы старый ssh-URL не плодил `last_error_message` после смерти туннеля).

## Что осталось / следующий шаг

- Подключить базовую схему БД (`users`, `conversations`, `messages`) и заменить stateless на полноценную историю — это следующий milestone в `ROADMAP.md`.
- `request_human` / handoff оператору — после появления `staff/order` сущностей (Sprint 2).
- Длинные ответы > 4096 символов разбиваем по строкам (см. `splitForTelegram` в `lib/telegram/handle-update.ts`); на текущей нагрузке это редкость, но граница покрыта.
