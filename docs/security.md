# Безопасность

## Threat model (что защищаем)

| Актив | От чего | Критичность |
|---|---|---|
| Секреты (API keys, DB credentials) | Утечка через код/логи | Critical |
| Деньги клиентов (payments) | Двойная оплата, кража | Critical |
| KYC-документы в Storage | Утечка | Critical |
| AI-агент | Prompt injection, использование как прокси | High |
| Бот | Spam, чрезмерный трафик | High |
| Admin-панель | Несанкционированный доступ | High |
| Диалоги клиентов | Утечка PII | High |

## Secrets

- **Все ключи** — в `env`, никогда в коде/коммитах
- `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `YOOKASSA_SECRET_KEY` — только server-side. Проверка при PR review
- `NEXT_PUBLIC_*` — только для клиентских нужд (Sentry DSN). Ничего чувствительного
- **Ротация** — при компрометации немедленно, плановая раз в 6 месяцев
- **Секреты не попадают в Sentry** — PII scrubbing включён, доп. denylist в `beforeSend`

## Подпись webhook'ов

### Telegram
- Заголовок `X-Telegram-Bot-Api-Secret-Token` обязателен
- Сравнение **constant-time** (избежать timing attack): `crypto.timingSafeEqual`

### YooKassa
- HMAC подпись (опционально в кабинете, но **включить обязательно**)
- Заголовок `Content-Signature: v1 <base64>`
- Проверка по `sha256` от body с ключом `YOOKASSA_WEBHOOK_SECRET`
- Fallback: IP whitelist (YooKassa публикует диапазоны)

### CryptoBot
- Заголовок `crypto-pay-api-signature`
- HMAC-SHA256 от body, ключ = SHA256(`CRYPTOBOT_TOKEN`)
- Обязательно

## Rate limiting

Upstash Ratelimit с скользящим окном.

| Endpoint | Лимит |
|---|---|
| `POST /api/bot` | 60 updates / сек / bot — на уровне Telegram, доп. защита не нужна |
| `POST /api/chat` | 20 сообщений / 5 мин / `web_session_id`; 60 / 5 мин / IP |
| `POST /api/payments/*` | 100 / мин / IP (от webhooks провайдеров) |
| `POST /api/attachments` | 20 / час / staff |
| `GET /api/catalog` | 60 / мин / IP (публичный) |
| Админские endpoints | 300 / мин / auth user |

Превышение — `429 Too Many Requests` с `Retry-After` header.

## Prompt injection (AI)

AI-агент — потенциальная точка атаки:
- **Не исполнять** инструкции из пользовательских сообщений, противоречащие system prompt
- Системный промпт явно запрещает: «не обсуждай обход санкций, политику, серые схемы»
- Детект на входе: эвристика на triggers (`ignore previous instructions`, `system:`, `you are now`) → не передавать модели, логировать, ответить нейтральной фразой
- Токен-лимит на вход: обрезать сообщения пользователя > 4000 символов
- Output sanitization: не рендерить ответ AI как HTML/Markdown без экранирования (в TG — plain text; в веб — escape)

## PII

### Что считаем PII
- `users.phone`, `users.email`
- Тексты сообщений (могут содержать email, номера карт, персональные данные)
- KYC-документы в Storage
- Telegram `username` (если сохраняли)

### Правила
- **Не логировать** полные сообщения в Sentry — только `messageId`, `conversationId`
- **Не логировать** номера карт — они никогда не должны проходить через наши серверы (YooKassa/CryptoBot хостят платёжные формы)
- KYC-документы — в private bucket, доступ только через signed URL с TTL 15 мин
- При детекте номера карты в сообщении пользователя — маскировать перед сохранением (`**** **** **** 1234`) и **не передавать AI**

### Удаление по запросу

Клиент может запросить удаление данных (GDPR-like):
- `users.display_name = 'Deleted'`, `phone = null`, `email = null`, `notes = 'deleted on <date>'`
- Сообщения остаются для audit, но `content = '[deleted]'`
- Заказы остаются (финансовый audit)

## RLS (см. database.md)

RLS включён **на всех** таблицах с user/staff данными. Пересмотр политик — перед продакшн-деплоем.

## HTTPS и cookies

- Все endpoints — только HTTPS (Vercel обеспечивает)
- Cookies: `HttpOnly`, `Secure`, `SameSite=Lax` (для `session` cookie)
- CSRF: Next.js Server Actions имеют встроенную защиту; для чужих endpoints — Origin header check

## Admin-панель

- `/admin/*` защищена middleware: проверка Supabase JWT + `staff.is_active`
- Отдельный 2FA (TOTP) для `admin`/`supervisor` ролей — Sprint 3 backlog
- Session timeout: 8 часов
- Audit log логинов: `staff_login_events` таблица (создать в Sprint 2 при появлении админки)

## Storage buckets

- Все buckets — `private`
- Доступ только через signed URL (Supabase SDK `createSignedUrl`)
- TTL signed URL: 15 минут (для preview), 1 час (для download ссылок клиенту)
- Upload — только через server-side endpoint с RLS проверкой

## Backup и recovery

- Supabase автоматический daily backup (Free) / PITR (Pro)
- Ручной экспорт критичных данных (orders + payments) раз в сутки в отдельный bucket (Sprint 3)
- Sentry хранит данные 90 дней; критичные события дублировать в Logtail (долгосрочное хранение)

## Checklist перед production

- [ ] Все env variables в Vercel Production, preview = dev keys
- [ ] RLS включён на всех таблицах, политики протестированы
- [ ] HMAC на всех платёжных webhook'ах
- [ ] Sentry PII scrubbing работает (проверить breadcrumb на тестовом сообщении)
- [ ] Rate limits настроены и проверены
- [ ] Webhook Telegram зарегистрирован с `secret_token`
- [ ] `SUPABASE_SERVICE_ROLE_KEY` не leakается в клиентский bundle (проверить `next build --analyze`)
- [ ] Dependency audit: `pnpm audit --prod` — нет critical
- [ ] Storage RLS проверены (попытка чужого доступа возвращает 403)
- [ ] Backup восстанавливается (хотя бы один тестовый restore)
