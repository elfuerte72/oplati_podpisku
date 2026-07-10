# Ось A — БД, переходы состояний, деньги, миграции

Жёсткие инварианты из CLAUDE.md (раздел «Архитектурные инварианты» + «Миграции БД»).
Каждый — стоп-кран, а не эвристика.

## A1 · `order_events` — append-only

- Никогда `UPDATE`/`DELETE` на `order_events`. Форсится триггером БД
  `order_events_append_only` (миграция `0018`), который бросает exception даже для
  `service_role`.
- Любое изменение статуса заказа = **новая строка** в `order_events` в **той же
  транзакции**, что меняет `orders.status`.
- ❌ Нарушение: `db.update(orderEvents)`, `db.delete(orderEvents)`, `UPDATE
  order_events`, `DELETE FROM order_events`; смена статуса без вставки события;
  вставка события отдельной транзакцией от смены статуса.

## A2 · Переходы статуса — только через `transitionOrder()`

- Единственный путь смены `orders.status` — `transitionOrder()` /
  `transitionOrderDetailed()` (`packages/db/src/repositories/orders.ts`).
- Прямой `UPDATE orders SET status = ...` (Drizzle `db.update(orders).set({ status })`
  или raw SQL) — **запрещён**.
- Целевой статус обязан быть в `allowedTransitions`
  (`packages/types/src/order-state-machine.ts`); нелегальный переход =
  `OrderTransitionError`. Проверь, что новый переход добавлен и в `allowedTransitions`.
- ❌ Нарушение: любая запись `orders.status` в обход `transitionOrder`; добавление
  нового статуса в enum без обновления `allowedTransitions`; переход, которого нет
  в матрице.

## A3 · Деньги — integer в минимальных единицах

- `amount_rub` — **копейки**; `original_amount`, `balance_usd_cents`,
  `card_issue_fee_kopecks` — **центы/копейки**. Тип колонки — `integer`/`bigint`,
  **никогда** `numeric`/`float`/`real`/`double`.
- Арифметика денег — только на целых. Курс/проценты (`COMMISSION_PERCENT`,
  `PAYSPACE_CARD_BUFFER_PERCENT`) — округление детерминированное (`Math.round`/
  `Math.ceil`), результат снова целый.
- ❌ Нарушение: `numeric`/`float` колонка для денег; `parseFloat`/`Number(x)` над
  суммой без перевода в минимальные единицы; `/100` в математике без обратного
  округления; смешение рублей и копеек; хранение дробей; float-накопление
  комиссии/буфера.

## A4 · Транзакционная атомарность

- Смена статуса + вставка `order_events` — в **одной** транзакции.
- claim платежа + `transitionOrder('paid')` — в **одной** транзакции
  (`processInvoicePaid`): сбой перехода откатывает claim.
- ❌ Нарушение: два отдельных `await` без общей `tx`; побочный эффект (Telegram,
  выпуск карты) внутри транзакции вместо «после commit у победителя гонки».

## A5 · Миграции — forward-only через Drizzle

- Источник схемы — `packages/db/src/schema.ts`. Поток: правка схемы → `db:generate`
  → новый `.sql` в `packages/db/migrations/`. Нумерация строго возрастающая.
- ❌ Нарушение: правка уже применённой миграции; ручной SQL мимо Drizzle; правка
  БД через Supabase Dashboard; изменение схемы без соответствующей миграции;
  рассинхрон `schema.ts` ↔ `migrations/`.
- **Destructive — только backward-compatible**: новые колонки `nullable` или с
  `default`; удаление колонки/таблицы — два деплоя (сначала перестать писать/читать,
  потом дропнуть). ❌ `NOT NULL` без default на существующей таблице; drop колонки,
  которую ещё читает код.
- **Enum-расширение — отдельной миграцией**: `ALTER TYPE ... ADD VALUE` нельзя в той
  же транзакции, где значение используется. ❌ Миграция, где `ADD VALUE` и
  DDL/DML с этим значением смешаны.

## A6 · Zod на границах репозиториев

- Входы публичных функций репозиториев и парсинг строк из БД — через Zod-схемы из
  `@oplati/types`. ❌ `as SomeType` без обоснования, `any`, доверие форме строки
  БД без парса на критичных путях.

## A7 · RLS-модель уровня схемы

- `services` — public read только для `is_active=true` (policy
  `services_public_read_active`); запись — service role. User-таблицы —
  deny-by-default. Проверь, что новая таблица получила RLS-политику осознанно, а не
  открыта публично по недосмотру (детальнее — ось C).
