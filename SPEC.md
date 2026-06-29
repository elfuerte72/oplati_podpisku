# SPEC — Реферальная (партнёрская) программа

> Спецификация фичи. Источник требований — `referral_rules.docx` v1.0 (июнь 2026). Рабочий план и этапы — [`plan.md`](plan.md). Дизайн кабинета — [`docs/referral-cabinet-mockup.html`](docs/referral-cabinet-mockup.html). Общие конвенции (стек, команды, структура, код-стайл, инварианты) — [`CLAUDE.md`](CLAUDE.md), здесь **не дублируются**, только дельта под фичу.
>
> **Скоуп этой спеки — Этап A (захват сети) + Этап B (ledger начислений).** Этапы C (месячная прогрессия), D (кабинет), E (выплаты + антифрод) специфицируются отдельно по мере подхода. Граница явная: что входит и что НЕ входит — см. §8.

## 1. Objective и пользователи

**Цель.** Дать клиентам/партнёрам персональную реферальную ссылку и платить им процент с **каждой успешной оплаты** в их сети до 3 уровней вглубь. Вознаграждение начисляется автоматически из маржи проекта (комиссия `COMMISSION_PERCENT`), копится на балансе партнёра, выводится от $10.

**Пользователи.**
- **Партнёр** — пригласивший. Видит сеть, ставку, баланс, выводит деньги (кабинет — Этап D).
- **Реферал** — приглашённый клиент. Для него поведение бота/чата не меняется; он просто пришёл по ссылке.
- **Оператор/владелец** — обработка выплат, антифрод (Этап E).

**Бизнес-инвариант экономики.** Максимальная цепочка начисления = `7% (L1) + 2% (L2) + 1% (L3) = 10%` ≤ `COMMISSION_PERCENT` (30% на проде). Платим из маржи, не сверх цены клиента.

## 2. Зафиксированные решения (дефолты по D-REF-1..11)

Все противоречия/развилки исходного документа решены ниже. Помечены `[verified]` (подтверждено примерами из самого документа/мокапа) либо `[assumption]` (разумный дефолт, владелец подтверждает при личной проверке).

- **D-REF-1 `[verified]` — пороги и ставки.** Канон — раздел 4 (круги). Ставки воспроизводят worked-примеры документа дословно (см. §3 проверку). Таблица ставок — §3.
- **D-REF-2 `[assumption]` — «оборот» = объём сети.** Сумма `original_amount` оплаченных заказов всей нижестоящей сети партнёра (L1+L2+L3) за календарный месяц. Собственные покупки партнёра в оборот для круга НЕ входят.
- **D-REF-3 `[assumption]` — окно оборота = календарный месяц (UTC)**, статус круга — навсегда (храповик).
- **D-REF-4 `[verified]` — база начисления = USD.** Процент считается от `orders.original_amount` (USD-центы). Балансы/выплаты — USD-центы integer. Пример: $15.99 × 4% = $0.64 — совпадает с документом.
- **D-REF-5 `[assumption]` — «активный реферал» = реферал с ≥1 заказом в статусе `paid`/`in_fulfillment`/`completed`.**
- **D-REF-6 `[deferred]` — способ выплат.** Не блокирует A/B. На Этапе E; до тех пор `referral_payouts` создаётся, исполнение — ручное оператором.
- **D-REF-7 `[assumption]` — временный +1% буст** применяется к ставке L1 beneficiary, действует один следующий календарный месяц.
- **D-REF-8 `[assumption]` — командный множитель** L2 2%→2.5% действует на тарифах с L2=2% (Круг 2/3); пересчитывается месячным кроном (Этап C).
- **D-REF-9 `[assumption]` — без ретроактивности.** Существующие `users` остаются без реферера; дерево строится только из новых переходов по ссылкам.
- **D-REF-10 `[assumption]` — «личный менеджер»/«совместный маркетинг»** — операционные плюшки: флаг достижения круга + уведомление; кода маркетинга нет.
- **D-REF-11 `[assumption]` — kill-switch `REFERRAL_ENABLED`**, выкатка по этапам A→B→C→D→E.

## 3. Таблица ставок (источник правды расчёта)

Состояние партнёра = **круг** (определяется месячным оборотом сети, храповик — не понижается). Ставка L1 фиксируется при достижении круга навсегда.

| Круг | Название | Порог (оборот/мес) | L1 | L2 | L3 | Бонус достижения | Семантика |
|---|---|---|---|---|---|---|---|
| 0 | Клиент | — (по умолчанию) | 4% | 1.5% | 0.5% | — | не зафиксирован |
| 1 | Старт | $500 | 4% | 1.5% | 0.5% | — | **фиксирует 4% навсегда** |
| 2 | Партнёр | $2 000 | 6% | 2% | 1% | +$50 + личный менеджер | фикс 6% |
| 3 | Топ-партнёр | $5 000 | 7% | 2% | 1% | +$150 + совм. маркетинг | фикс 7% |

Модификаторы (Этап C, в A/B закладываем поля, но не активируем):
- **Командный множитель:** L2 2% → 2.5% при 5+ активных рефералах L2 (только Круг 2/3).
- **Спринт-буст:** +1% к L1 на следующий месяц при обороте ≥150% порога текущего круга.

**Проверка таблицы примерами из документа и мокапа (D-REF-1 = verified):**
| Источник | Расчёт | Ожидание | Факт |
|---|---|---|---|
| Док: Netflix Клиент L1 | $15.99 × 4% | $0.64 | $0.6396 ✓ |
| Док: Netflix Топ L1 | $15.99 × 7% | $1.12 | $1.1193 ✓ |
| Мокап: Ур.1 Netflix (Круг 2) | $15.99 × 6% | $0.96 | $0.9594 ✓ |
| Мокап: Ур.2 Spotify (Круг 2) | $9.99 × 2% | $0.20 | $0.1998 ✓ |
| Мокап: Ур.1 ChatGPT (Круг 2) | $20.00 × 6% | $1.20 | $1.20 ✓ |

Ставки в коде — bps (basis points): 400/150/50, 600/200/100, 700/200/100. Округление суммы начисления — **вниз** (`floor`), USD-центы. Конфиг — единственная константа `REFERRAL_RATE_TABLE` в `@oplati/types` (не хардкод по месту).

## 4. Требования и критерии приёмки

### Этап A — захват сети + реферальный код

**A1. Схема.** `users.referred_by uuid` (self-FK, nullable), `users.referral_code text UNIQUE` (короткий, URL-safe). Миграция через Drizzle (forward-only).
- AC: миграция применяется на чистую БД; индекс на `referred_by`; `referral_code` UNIQUE; обе колонки nullable (backwards-compatible).

**A2. Генерация кода.** Короткий код (8–10 символов, base32-без-неоднозначных), коллизионно-безопасный (retry при конфликте UNIQUE).
- AC: 10k генераций без коллизии в тесте; код стабилен (один на пользователя, лениво при первом запросе ссылки или при создании).

**A3. Захват реферера.** Бот: `/start ref_<code>` (рядом с `LINK_TOKEN_PREFIX` в `handle-update.ts`). Веб: `?ref=<code>` → сохранить в cookie до первого создания user.
- AC: новый пользователь, пришедший по `ref_<code>`, получает `referred_by = owner(code)`.
- AC: `referred_by` ставится **только при создании** пользователя (immutable: повторный `/start ref_*` уже существующего юзера дерево не меняет).
- AC: **самореферал отклоняется** (нельзя стать рефералом самого себя).
- AC: невалидный/несуществующий код — пользователь создаётся без реферера, без ошибки.
- AC: при `REFERRAL_ENABLED=0` захват не происходит (флоу как сейчас).

**A4. Репозиторий `referrals.ts`** (в `@oplati/db`): `resolveReferralCode(code) → userId|null`, `setReferrerOnce(userId, referrerId)` (guard самореферала + immutable), `getReferralAncestors(userId, 3) → [{userId, level}]`.
- AC: `getReferralAncestors` корректно отдаёт до 3 предков по `referred_by`, обрывается на null/корне, level ∈ {1,2,3}.
- AC: учтена merge-логика `consumeLinkToken` (привязка TG↔web не теряет/не задваивает реферера).

**A5. Тесты.** Захват кода, самореферал отклонён, immutable, обход дерева 3 уровня, цикл-guard (A→B→A невозможен, т.к. immutable).

### Этап B — ledger начислений

**B1. Схемы.** `referral_partners` (профиль), `referral_accruals` (append-only ledger), `referral_payouts` (заявки). Enum'ы (`referral_accrual_kind`, `referral_accrual_status`, `referral_payout_status`) — **отдельной миграцией** (ограничение `ALTER TYPE ADD VALUE`, см. CLAUDE.md). RLS на всех; партнёр читает только своё.
- AC: `referral_accruals` имеет `UNIQUE(payment_id, beneficiary_user_id, level)` (идемпотентность commission).
- AC: денежные поля integer USD-центы.

**B2. Начисление `accrueReferral(orderId)`** — вызывается в `processInvoicePaid` **сразу после** `claimPaymentSucceeded` (точка at-most-once). Обход 3 уровней, расчёт ставки по `REFERRAL_RATE_TABLE` + модификаторы, INSERT строк kind=`commission`.
- AC: при оплате заказа реферала начисляются строки всем предкам (до 3) по их ставкам уровня.
- AC: **идемпотентность** — повторный webhook/poll того же платежа не создаёт дублей (ON CONFLICT DO NOTHING по UNIQUE).
- AC: **graceful** — исключение в accrueReferral НЕ роняет обработку платежа (try/catch + Sentry); заказ всё равно `paid`.
- AC: **suspended-партнёр исключается** из начисления.
- AC: инвариант «сумма всех начислений по заказу ≤ комиссия заказа» соблюдается (проверка в коде).
- AC: при `REFERRAL_ENABLED=0` начисление пропускается.

**B3. Баланс.** `getReferralBalance(userId) = SUM(accruals WHERE status=accrued) − SUM(payouts WHERE status∈{processing,paid})`.
- AC: баланс = сумма начислений минус выведенное; reversed-строки не учитываются.

**B4. Recovery-cron.** Заказы `paid`/`in_fulfillment`/`completed` без строк начисления → досчитать (паттерн `findStuckPaidOrders`). Гейт `REFERRAL_ENABLED`.
- AC: пропущенное начисление (БД упала в момент оплаты) досчитывается следующим запуском, идемпотентно.

**B5. Тесты** на мок-БД (стиль `loveandpay`): начисление 3 уровня, идемпотентность повтора, инвариант ≤ маржа, suspended исключён, баланс, recovery.

## 5. Модель данных (точные сущности)

```
users (extend):
  referred_by   uuid NULL  REFERENCES users(id)         -- immutable после установки
  referral_code text NULL  UNIQUE                        -- короткий, lazy

referral_partners:
  user_id            uuid PK REFERENCES users(id)
  current_circle     smallint NOT NULL DEFAULT 0         -- 0..3
  locked_rate_l1_bps integer  NOT NULL DEFAULT 400       -- храповик
  boost_until        date     NULL                        -- временный +1% (Этап C)
  boost_rate_bps     integer  NULL
  team_multiplier    boolean  NOT NULL DEFAULT false     -- 5+ активных L2 (Этап C)
  suspended          boolean  NOT NULL DEFAULT false     -- антифрод
  created_at         timestamptz NOT NULL DEFAULT now()

referral_accruals (append-only):
  id                 uuid PK
  beneficiary_user_id uuid NOT NULL REFERENCES users(id)
  source_user_id     uuid NULL REFERENCES users(id)      -- кто оплатил (null для бонусов)
  order_id           uuid NULL REFERENCES orders(id)
  payment_id         uuid NULL REFERENCES payments(id)
  level              smallint NOT NULL                    -- 1..3; 0 для бонусов
  kind               referral_accrual_kind NOT NULL       -- commission|circle_bonus|sprint_new_refs|sprint_turnover_boost|serial_bonus
  rate_bps           integer NOT NULL
  amount_usd_cents   integer NOT NULL
  status             referral_accrual_status NOT NULL DEFAULT 'accrued'  -- accrued|reversed
  created_at         timestamptz NOT NULL DEFAULT now()
  UNIQUE(payment_id, beneficiary_user_id, level)          -- идемпотентность commission

referral_payouts:
  id               uuid PK
  user_id          uuid NOT NULL REFERENCES users(id)
  amount_usd_cents integer NOT NULL
  status           referral_payout_status NOT NULL DEFAULT 'requested'  -- requested|processing|paid|rejected
  destination      jsonb NULL                              -- зависит от D-REF-6 (Этап E)
  requested_at     timestamptz NOT NULL DEFAULT now()
  settled_at       timestamptz NULL

referral_monthly_stats (Этап C — поля заложить, крон позже):
  user_id        uuid, month date, network_turnover_usd_cents integer,
  new_active_referrals integer, plan_met boolean, computed_at timestamptz
  PRIMARY KEY (user_id, month)
```

## 6. Тестовая стратегия

- **Уровень 1 (основной):** Vitest на мок-БД/мок-handlers — как `apps/web/lib/loveandpay/*.test.ts`. Покрывает захват сети, расчёт ставок, идемпотентность, graceful, баланс, recovery.
- **Конфиг-ставки:** unit-тест, что `REFERRAL_RATE_TABLE` воспроизводит 5 worked-примеров из §3.
- **State/типы:** Zod-схемы границ (deep-link payload, payout request) в `@oplati/types` с тестами.
- **Без `Date.now()` в логике прогрессии** — «текущий месяц» передаётся параметром (тестируемость, как в существующих cron-джобах).
- Зелёные `pnpm typecheck` + `pnpm lint` + затронутые vitest перед ревью.

## 7. Boundaries

**Always (всегда делать):**
- Деньги — integer USD-центы; начисления — append-only; reversal = новая строка.
- Идемпотентность начисления через `UNIQUE(payment_id, beneficiary, level)` + at-most-once в точке claim.
- Zod на всех входных границах; RLS на всех новых таблицах.
- Миграции только через Drizzle (`db:generate` → `db:push`/`db:migrate`); enum-расширения отдельной миграцией.
- Conventional Commits; границы пакетов из CLAUDE.md (agent не лезет в db напрямую; types только zod).
- Reuse существующих паттернов: `transitionOrder`, `claimPaymentSucceeded`, dispatcher, `findStuckPaidOrders`.

**Ask first (спросить владельца):**
- Любое отклонение от дефолтов D-REF-2/4/5/7/8 при личной проверке.
- Способ/валюта выплат (D-REF-6) до старта Этапа E.
- Включение `REFERRAL_ENABLED` на проде.

**Never (никогда):**
- Прямой `UPDATE/DELETE` по `referral_accruals` (только INSERT).
- Начисление вне точки `claimPaymentSucceeded` (риск дублей/двойной траты).
- Начисление, превышающее комиссию заказа.
- Менять `referred_by` после установки (immutable — иначе переписывание дерева задним числом).
- Деплой на прод в рамках этого цикла (только preview; владелец проверяет лично).
- Self-referral; ретроактивная привязка существующих юзеров без явного решения.

## 8. Что НЕ входит в текущий скоуп (границы)

- **Этап C** — месячный крон прогрессии (круги/спринты/серии/множитель), уведомления. Поля в схеме заложены, логика — отдельно.
- **Этап D** — кабинет (API + UI по мокапу). Read-only снапшот, экраны, заявка на вывод.
- **Этап E** — исполнение выплат (D-REF-6), антифрод (детект накрутки, suspend, reversal/clawback), уведомление об изменении условий (30 дней).

## 8.1. Находки код-ревью — статус (2 агента: code-reviewer + security-auditor)

**Исправлено в этом цикле:**
- Атомарность начисления (`db.transaction` в `insertCommissionAccruals`) — частичная вставка больше не ломает recovery-гейт.
- Anti-retro гейт recovery (H-1): `users.referred_by_set_at` + `paid_at >= referred_by_set_at` + окно 30д — merge не back-pay'ит комиссию на исторические заказы (D-REF-9).
- Merge-хардненинг: перенос `referral_accruals`/`referral_payouts`/`referral_partners` с удаляемой web-строки (M-2, иначе restrict-FK рушит привязку); цикл-чек при inherit/repoint (M-1).
- Баланс вычитает `requested`-выплаты + `::bigint` (M-3); ревалидация cookie `ref`; CHECK `referred_by <> id`.

**Отложено на Этап E (задокументировано, не блокирует A+B; программа дремлет до Этапа D + `REFERRAL_ENABLED=1`):**
- **L-1** — идемпотентность начисления по `payment_id`, а экономическое событие — на заказ. Два `succeeded`-платежа на заказ (near-impossible по флоу `ready_for_payment`→`pending_payment`+409) дали бы двойное начисление на inline-пути. Защита: per-order ключ ИЛИ partial-unique `payments(order_id) WHERE status='succeeded'` (не добавлен сейчас — риск уронить prod-миграцию при дублях). Recovery уже защищён через `DISTINCT ON`.
- **L-2** — мультиаккаунт-самореферал (одна персона = два аккаунта) не детектируется. Нужны Этап E `suspended`-энфорсмент (хук уже есть в `accrue.ts`) + сигналы (общий платёжный инструмент, device/IP-кластеры, velocity). **`REFERRAL_ENABLED=1` не включать до этого.**
- **Snapshot ставки** — `accrue.ts` берёт ставку из текущего профиля партнёра; с приходом Этапа C (мутирующий круг/буст) решить, не снапшотить ли круг на момент оплаты (recovery через месяц иначе посчитает по другой ставке). Сейчас профили статичны — расхождения нет.

## 9. Definition of Done (для цикла /loop)

1. Этапы A + B реализованы, `REFERRAL_ENABLED` по умолчанию off.
2. `pnpm typecheck` + `pnpm lint` + vitest — зелёные.
3. Локальное ревью (`/agent-skills:review`) + greptile — замечания закрыты.
4. Ветка `feat/referral-program` задеплоена на **preview** (НЕ прод), webhook dev-бота перерегистрирован, smoke пройден.
5. Передано владельцу на **личную проверку**; цикл открыт до его подтверждения «реализовано верно».
