# State Machine заказа

Заказ (`orders.status`) живёт по строгой state machine. Любой переход — атомарная транзакция: меняется `status` + вставляется строка в `order_events`.

## Диаграмма

```
    [draft]
       │ AI сформулировал черновик (propose_order)
       ↓
    [clarifying] ─────── нужен KYC ───────→ [kyc_required]
       │                                        │
       │ детали подтверждены                    │ KYC завершён
       ↓                                        │
    [ready_for_payment] ←─────────────────────── ┘
       │
       │ confirm_order: создан invoice
       ↓
    [pending_payment]
       │                           │                              │
       │ успешный webhook           │ timeout (60 мин)              │ user cancel
       ↓                           ↓                              ↓
    [paid]                      [expired]                    [cancelled]
       │
       │ оператор принял в работу
       ↓
    [in_fulfillment]
       │                          │
       │ оператор подтвердил       │ fulfillment failed
       ↓                          ↓
    [completed]                [failed]
       │                          │
       │                          │ user/operator инициировали возврат
       │                          ↓
       │                     [refund_requested]
       │                          │
       │                          │ supervisor одобрил + деньги вернулись
       │                          ↓
       │                     [refunded]
       │
       └── (на любом моменте до completed, пользователь может запросить возврат, что ведёт в refund_requested)
```

## Полная таблица переходов

| From | To | Actor | Trigger | Побочные эффекты |
|---|---|---|---|---|
| — | `draft` | `ai`/`user` | первое обращение, tool `propose_order` | создать запись `orders`, `order_events(event_type='created')` |
| `draft` | `clarifying` | `ai` | собраны частичные детали | — |
| `draft` | `cancelled` | `user` | передумал | `cancelled_at = now()` |
| `clarifying` | `kyc_required` | `ai` | `requires_kyc=true` по каталогу или AI-детект | уведомление пользователю: что нужно для KYC |
| `clarifying` | `ready_for_payment` | `ai` | все детали есть, KYC не нужен или уже пройден | — |
| `clarifying` | `cancelled` | `user` | — | `cancelled_at = now()` |
| `kyc_required` | `clarifying` | `ai`/`operator` | KYC данные получены | `kyc_completed_at = now()` |
| `kyc_required` | `cancelled` | `user` | — | — |
| `ready_for_payment` | `pending_payment` | `ai` | tool `confirm_order` | создать запись `payments(status='pending')`, получить ссылку у провайдера, отправить пользователю |
| `ready_for_payment` | `cancelled` | `user` | — | — |
| `pending_payment` | `paid` | `payment_provider` | webhook `succeeded` | `paid_at = now()`, обновить `payments(status='succeeded')`, уведомить пользователя + создать topic оператору |
| `pending_payment` | `expired` | `system` | cron `expire-payments` — истёк timeout (60 мин) | `payments(status='failed')`, уведомить пользователя |
| `pending_payment` | `cancelled` | `user` | отмена до оплаты | — |
| `paid` | `in_fulfillment` | `operator` | operator нажал «взять в работу» | `assigned_operator_id = staff.id`, уведомить пользователя «заказ в работе» |
| `paid` | `refund_requested` | `user`/`supervisor` | проблема между оплатой и началом работы | — |
| `in_fulfillment` | `completed` | `operator` | `fulfillment_proof` загружен, оператор подтвердил | `fulfilled_at = now()`, уведомить пользователя + прислать proof |
| `in_fulfillment` | `failed` | `operator`/`supervisor` | не удалось оплатить сервис | уведомить пользователя, предложить refund |
| `completed` | `refund_requested` | `user`/`supervisor` | клиент жалуется после выполнения | — |
| `failed` | `refund_requested` | `operator`/`supervisor` | auto после failure | — |
| `refund_requested` | `refunded` | `supervisor` | деньги возвращены через провайдера | `refunded_at = now()`, обновить `payments(status='refunded')` |
| `refund_requested` | `cancelled` | `supervisor` | отказ в возврате (спор) | — |

## Терминальные статусы

`completed`, `refunded`, `cancelled`, `expired` — финальные, из них переходов нет (кроме `completed → refund_requested` как edge case).

## Реализация

### Функция перехода

Каждый переход реализуется через единую функцию:

```typescript
async function transitionOrder(
  orderId: string,
  to: OrderStatus,
  actor: { type: ActorType; id?: string },
  payload?: Record<string, unknown>,
): Promise<Order>
```

Внутри:
1. Открыть транзакцию
2. `SELECT ... FOR UPDATE` заказа
3. Проверить `canTransition(from, to)` (см. `@oplati/types`) — иначе throw `InvalidTransitionError`
4. Вызвать side-effect hook (опционально) в пределах транзакции
5. `UPDATE orders SET status = to, <timestamps>` 
6. `INSERT INTO order_events (...)` с payload
7. Commit

Все операции чтения статуса в других местах кода используют **только** результат этой функции.

### Побочные эффекты вне транзакции

Уведомления (Telegram, email) делаются **после** коммита, через Trigger.dev события:
- Транзакция коммитит переход + пишет `order_events`
- Отдельная Trigger.dev task подписывается на `order.status_changed` и рассылает уведомления

Это избегает "уведомил, но транзакция откатилась" и "commit прошёл, но уведомление не ушло" — at-least-once через retry Trigger.dev.

### Timeouts

- `pending_payment → expired`: ровно 60 минут с момента перехода. Cron `expire-payments` раз в 10 мин.
- `in_fulfillment > 2h` без terminal — не переход, а **алерт** супервизору (через отдельный cron `alert-slow-fulfillment`).

## Запрещённые практики

- Менять `orders.status` напрямую SQL'ем минуя `transitionOrder()` — **никогда**
- Удалять строки `order_events` — **никогда**
- Проверять статус заказа по одному лишь полю без учёта `order_events` timeline в спорных случаях
- Запускать side-effect'ы в транзакции (внешние API-вызовы, send Telegram message) — только через post-commit hook/очередь
