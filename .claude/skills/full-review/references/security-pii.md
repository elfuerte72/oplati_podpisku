# Ось C — Безопасность, PII, RLS, rate-limit

Жёсткие инварианты из CLAUDE.md (разделы «Защита AI-расходов», «Безопасность
реквизитов», «Архитектурные инварианты» п.7/8/9, «Конвенции кода», «Что запрещено»).
Проверяется на **любом** diff.

## C1 · PAN / CVC / секреты — никогда в логи, БД, Sentry

- Полные `pan`/`cvc`/номера карт/токены/секреты **никогда** не пишутся в
  `logger.*`, БД, Sentry, `console`. В БД — только `pan_masked`.
- Полные реквизиты уходят клиенту **единственным путём** — сообщением в Telegram.
- `cardType`/`productCode`, billing address, `card/info` — **не сохраняются в БД**,
  только добавляются в финальное Telegram-сообщение.
- ❌ Нарушение: полный PAN/CVC в аргументе `logger`/`Sentry.captureException`/
  `console`; сохранение полного PAN/CVC/реквизитов в колонку; лог токена/секрета/
  `initData`/webhook-подписи; попадание реквизитов в ответ HTTP-эндпоинта.

## C2 · RLS — deny-by-default на user-таблицах

- Весь доступ к user-таблицам (`users`, `orders`, `payments`, `cards`,
  `messages`, `referral_*`, …) — только `service_role`/прямое подключение.
  Браузерный `anon`-клиент читать их не должен.
- `services` — public read только `is_active=true` (policy
  `services_public_read_active`); запись — service role.
- ❌ Нарушение: клиентский Supabase-запрос (`lib/supabase/browser`) к user-таблице;
  новая таблица без RLS или с публичной политикой по недосмотру; ослабление RLS
  ради клиентского доступа вместо per-user policy; `service_role`-ключ в клиентском
  бандле / `NEXT_PUBLIC_*`.

## C3 · Rate-limit до сессии и записей в БД

- Неаутентифицированные write-эндпоинты зовут `checkRateLimit` (`lib/ratelimit.ts`,
  Upstash) **до** резолва сессии и любых записей: `/api/chat` (по IP),
  `/api/orders/propose`, `/api/orders/confirm`, `/api/auth/telegram/link`,
  `/api/bot` (по `telegram_id`). Иначе cost-DoS на строки `users`/`orders`/
  `link_tokens`.
- Rate-limit стоит **до** Haiku-роутера и до агента.
- Fail-open при незаданном Upstash (env `KV_REST_API_*`/`UPSTASH_REDIS_REST_*`).
- ❌ Нарушение: новый неаутентифицированный write-эндпоинт без `checkRateLimit`;
  rate-limit после `getSession`/после `INSERT`; лимит после роутера/агента.

## C4 · Timing-safe сравнение секретов

- Сравнение `X-Internal-Token`, webhook secret-token, подписей — через
  timing-safe (`crypto.timingSafeEqual`, см. `security/timing-safe` тест), не `===`.
- ❌ Нарушение: `token === expected` / `a == b` для секрета/подписи; сравнение
  строк разной длины без защиты.

## C5 · Sentry — PII-скраб

- `lib/sentry.ts` `beforeSend` вычищает PII. Новый способ логирования ошибок не
  должен обходить `beforeSend` и лить PII/реквизиты/токены в Sentry.
- ❌ Нарушение: прямой вызов Sentry в обход shared-опций; добавление PII в
  `extra`/`tags`/`contexts`.

## C6 · fetch без timeout запрещён

- Любой `fetch` к внешнему API — с `AbortController`/timeout. Внешние: Anthropic,
  L&P, PaySpace, Telegram, Random User, Upstash.
- ❌ Нарушение: `await fetch(url)` без сигнала таймаута; висящий запрос без отмены.

## C7 · Never swallow errors

- `catch {}` и `catch { console.log(...) }` — запрещены. Либо re-throw, либо
  `Sentry.captureException` + structured error. Ожидаемые неудачи — Result pattern
  (`{ ok: false, reason }`), не молчаливое проглатывание.
- ❌ Нарушение: пустой `catch`; `catch`, только логирующий и продолжающий на
  критичном пути; проглоченная ошибка платежа/выпуска карты/БД.

## C8 · console.log и секреты в коде

- В production-коде только `logger.*` (pino), не `console.log`. `.env*`/реальные
  токены не коммитятся, не пастятся в код/логи.
- Контракт внешнего API (PaySpace, L&P) не выдумывается — только подтверждённый
  живым вызовом/докой владельца.
- ❌ Нарушение: `console.log`/`console.error` в prod-пути; хардкод токена/ключа/
  секрета; захардкоженный «предполагаемый» формат ответа внешнего API.

## C9 · Zod на всех внешних границах

- Webhook body, Telegram updates, AI tool inputs, URL/query params, `initData` —
  парсятся Zod-схемой из `@oplati/types`. Не `any`, не `as T` без обоснования.
- ❌ Нарушение: доступ к `body.foo`/`req.query` без парса; `as SomeType` над
  недоверенным входом; `JSON.parse` без валидации.

## C10 · Проверка подписи initData / вебхуков

- Mini App `/api/cabinet` — проверка подписи `initData` на **каждый** запрос
  (`lib/cabinet/auth.ts`). L&P webhook — подпись. `/api/bot` — secret-token.
- ❌ Нарушение: обработка запроса кабинета/webhook до валидации подписи; доверие
  `initData.user`/`start_param` без верификации HMAC.
