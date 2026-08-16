# Тестовый ландшафт

Что покрыто тестами и какой баг каждый регресс держит. Список ведётся руками и неизбежно
отстаёт от репозитория — **источник правды о покрытии — сами файлы** (`**/*.test.ts`),
здесь фиксируется то, чего в них не прочитать: какой инцидент породил тест.

Выделено из `CLAUDE.md` 2026-08-14.

## Инварианты тестирования

- **`packages/db` тестируется на PGlite** — реальный Postgres и реальные миграции, а не мок.
  Только так проверяются атомарные claim'ы, append-only-триггер и RLS.
- ⚠️ **Пакет без `test`-скрипта молча пропускается** общим прогоном `pnpm -r --if-present test`.
  Так `packages/agent` числился покрытым и не гонялся до 2026-08-11.
- `pnpm typecheck` проверяет и сами тесты (L-14).

## Покрытие и история регрессов

**Состав.** Vitest в `apps/web` (loveandpay: client/sign/handlers; rapira: live-rate/fallback; pay-space: client/sign/format; ai: бюджет/роутер; chat: toolCards; ratelimit; security/timing-safe; jobs/issue-card + recycle-cards + referral-rollup + referral-accrual-recovery; cabinet/referral: снапшот/auth/payout; referral/payout-executor + accrue; orders/propose rate-limit; telegram/init-data: `start_param` из подписанного initData), `packages/types` (state machine, схемы L&P/Rapira, referral: ставки + прогрессия + выплаты) и `packages/db` (**интеграционные на PGlite** — реальный Postgres + реальные миграции: атомарный claim и его откат в транзакции, идемпотентность webhook, append-only-триггер, guard оплаченного заказа в expire, merge пользователей, идемпотентность+reversal ledger'а, машина статусов выплат, реферальный захват `getOrCreateUserByTelegramId` ставит `referred_by`+`referred_by_set_at`). Всего **web 1048, types 186, db 136, agent 40** (2026-08-15 — антифрод-трек: контакты (email/phone-нормализация, `isPhoneRequiredForAmount`, redact-канарейка контактов), гейты `email_required`/`phone_required` в `payments/create`/`confirm`/кабинете, `payment_review` в стейт-машине и PGlite (полл-окно без потолка, merge-перенос контактов, `touchUserLastSeenIp`, `countRefundishHistoryByUser`), poll-обработка холда + `payment-review-watch`, contact-flow бота, `reportPaymentProblem`; 2026-08-14 — отмена реферальных начислений по провалившемуся заказу — идемпотентность, гейт по статусу заказа, заказ с двумя платежами, зеркальная сверка «партнёру недоплачено», отрицательный месяц и баланс в снапшоте кабинета, порядок «переход → реверс» в `markOrderFailed`; ранее — пачки 11–13 аудита — денежные пути `confirm_order` и вебхука L&P, `authorizeCron` с fail-closed и `X-Internal-Token`, диспатч tools + Zod-граница + роутер агента, действия кабинета, порядок rate-limit в `/api/orders/confirm`, привязка с handoff'ом заказа и **поведенческая проверка RLS под ролями `anon`/`authenticated`** через `SET ROLE`). ⚠️ У `packages/agent` тесты появились только 2026-08-11: без `test`-скрипта пакет молча пропускался общим прогоном `pnpm -r --if-present test`, при том что этот файл заявлял покрытие. Теперь он в прогоне автоматически.

### Регрессы по волнам аудитов

Каждый пункт — тест, посаженный на конкретную находку.

- регрессы аудита 2026-07-08: pay-space `rawBody`-утечка/`createCard`-идемпотентность, ratelimit `getClientIp` анти-спуфинг, loveandpay terminal-claim, renewal-reminder дедуп, agent tool-inputs Zod;

- регрессы аудита 2026-07-11: атомарность terminal-claim+перехода в одной транзакции с откатом (F-05, PGlite + unit), canary PII-скраббера Sentry/pino на pan/cvc/cvv/cardNo/initData/signature/`?s=` (F-06);

- Rapira 2026-07-14: Zod-контракт, выбор `askPrice`, HTTP/contract fallback и формула 30% + разовые $4;

- клиентский путь 2026-07-18: схема `servicePaymentInstructions`, пункты `instructionPoints`, passthrough инструкций в витрине, `buildPaymentIssueOperatorMessage` (экранирование/обрезка/контекст), `cardValidUntil` 180 дней;

- live-balance: приоритет active-карты, CAS-кэш при расхождении и проигрыш гонки параллельному topup (PGlite + unit), деградация на сбое/таймауте, контраст syncCardBalance vs updateBalance по `last_used_at`; redact PAN-подобных последовательностей в комментарии клиента перед DM оператору;

- аудит 2026-07-18: `toAgentHistory` user-first, `isPriceLockExpired` граница, PGlite `findExpiredPayableOrders` на протухший черновик + `setOrderExpiresAt`, TTL заказа 2ч в propose, healthcheck прокси c дедупом DM, классификатор `isPaymentProviderUnavailable`;

- M-волна: PGlite цикл-чек `setReferrerOnce` и откат INSERT платежа в транзакции, первый route-тест `payments/create` (транзакционная связка + гейт order_expired), amount_mismatch терминальный путь + дедуп DM на повторе;

- M-волна 2 (M-5..M-10): парсер суммы с запятой тысяч («1,000»→$1000, «1,00» двусмысленно → invalid), `service_unavailable` на битой pricing_policy (клиентская цена не принимается), Zod-схемы ответов партнёрского API `referral-api-schemas`;

- волна LOW 2026-07-19: /api/chat флаг, buildOrderExpiredMessage, redirect-manual healthcheck, expire-payments оркестрация (T-3), payOrder строго pending + extractInvoiceLink (T-4), route-тест repeat_confirm/23505 (T-1), таймаут POST L&P без ретрая, retention-джоб, exp_date карты, supportOperatorChatId env-only). **`pnpm typecheck` теперь проверяет и тесты** (L-14).

- Пачки 5–10 аудита 2026-08-10 (2026-08-11): анти-абьюз бота и кабинета, таймаут на ЧТЕНИЕ ТЕЛА у клиентов провайдеров, дедуп `update_id`, usage при сбое tool-loop + `pause_turn`/`max_tokens`/`refusal`, самореферал и единый источник ставки, обнаружение пропущенного месяца прогрессии и гейт тарифов.

- Инцидент 2026-08-16 (пустые Sentry-алёрты): `lib/alerts/sentry` + route — боевой payload internal integration (`data.event`, `environment` в `tags`, `triggered_rule`) доезжает с названием, местом, окружением и человеческой ссылкой; legacy-форма по-прежнему разбирается; тег неожиданной формы НЕ роняет разбор (иначе алёрт терялся бы молча); неизвестные поля не печатаются прочерком; отсутствие заголовка даёт `degraded`. ⚠️ Прежние тесты были написаны по legacy-форме и потому годами держали зелёным парсер, который на проде не работал — при правке разбора внешнего payload'а фикстуру брать из ДОКИ или живого вызова, а не из своего представления о формате.

- Инцидент 2026-08-16 (отказ Freekassa по `nonce`): `nonce-alert` — распознавание отказа по дословному тексту провайдера, дедуп личка/Sentry (личка раз в час, Sentry на каждом событии), молчание на прочих сбоях шлюза (подпись, контракт-дрейф, транспорт), never-throw на упавшем Telegram; `client` — наблюдатель `onApiError` видит и API-отказ с путём запроса, и транспортный сбой, а на успехе не зовётся. ⚠️ Сам сценарий «провайдер обогнал наш счётчик» тестом не воспроизводится (состояние живёт у Freekassa) — покрыта только реакция на него.

### Известная слепая зона: PGlite ≠ прод-драйвер

Интеграционные тесты `packages/db` гоняются на PGlite, а прод ходит через
**postgres-js** — сериализация параметров у них разная. Инцидент 2026-08-15
(PR #162): `Date`-объект в raw-`sql`-фрагменте PGlite переваривал (тесты
зелёные), postgres-js падал `TypeError` на каждом тике крона. Регресс-теста на
это НЕТ и не может быть в текущей схеме — класс багов ловится только на
проде/dev-стенде; охраняется правилом «в raw-`sql` только ISO-строки»
(«Конвенции кода» CLAUDE.md) и комментариями в местах инцидента.
