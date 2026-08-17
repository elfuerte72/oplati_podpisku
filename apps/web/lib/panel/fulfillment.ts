import type { OrderStatus } from '@oplati/types';

/**
 * Ручное исполнение заказа (тикет 06) — правила, отделённые от Next и от БД.
 *
 * ⚠️ Модуль читает и КЛИЕНТСКИЙ компонент (кнопки на карточке заказа), поэтому
 * здесь нет ни zod, ни чего-либо ещё тяжёлого: за две константы длины
 * комментария браузер не должен тянуть схемную библиотеку. Разбор тела запроса
 * живёт на границе — в route-handler'е.
 *
 * Случай, породивший требование: 2026-08-14 заказ ORD-J6TBP — клиент заплатил
 * 11 680 ₽, на выпуск карты нужно было ~$124, на VCC-субаккаунте лежало $89.50.
 * Карту пополнили и реквизиты отправили вручную, а заказ остался `failed`: вне
 * выручки и с погашенной комиссией партнёра.
 *
 * Шага ДВА и это принципиально: `order_events` append-only и по нему считается
 * выручка. «Беру в ручную выдачу» и «выдал» честно записывают, что работа
 * начиналась и кем. Прыжок сразу в `completed` такой записи не оставит.
 */

/** Комментарий обязателен на первом шаге: журнал без причины бесполезен. */
export const MANUAL_FULFILLMENT_COMMENT_MIN = 10;
export const MANUAL_FULFILLMENT_COMMENT_MAX = 500;

/** Типы событий журнала. Строки фиксированы: по ним потом читают историю. */
export const MANUAL_FULFILLMENT_STARTED = 'manual_fulfillment_started';
export const MANUAL_FULFILLMENT_COMPLETED = 'manual_fulfillment_completed';

/**
 * Можно ли взять заказ в ручную выдачу.
 *
 * Два условия, и второе не менее важно первого:
 *
 * 1. статус `failed` — остальные пути (`paid → in_fulfillment`) ведёт автомат,
 *    и вмешиваться в них руками значило бы соревноваться с ним за один заказ;
 * 2. **по заказу есть успешный платёж**. `failed` — НЕ синоним «деньги
 *    получены, товар не доставлен». В него же попадают заказ, по которому
 *    провайдер отверг счёт (денег не было вовсе), и недоплата (пришла часть, и
 *    это терминально). Ручная выдача такого заказа записала бы в выручку
 *    деньги, которых нет, а вместе с ней — «Оплачено» в карточке клиента и
 *    признак совершённой покупки для антифрода реферальной программы.
 */
export function canStartManualFulfillment(
  status: OrderStatus,
  hasSucceededPayment: boolean,
): boolean {
  return status === 'failed' && hasSucceededPayment;
}

/** Из какого статуса можно отметить «выдал». Существующий переход, не новый. */
export function canCompleteManualFulfillment(status: OrderStatus): boolean {
  return status === 'in_fulfillment';
}

/**
 * Действия и их тип — из одного массива: `z.enum` на границе строит схему
 * ИЗ НЕГО, поэтому «добавили действие, забыли схему» физически не набирается.
 */
export const MANUAL_FULFILLMENT_ACTIONS = ['start', 'complete'] as const;

export type ManualFulfillmentAction = (typeof MANUAL_FULFILLMENT_ACTIONS)[number];

/**
 * Какой статус ожидается для действия. Вызывающий сверяет его ДО перехода,
 * чтобы отдать человеку понятный отказ, а не `OrderTransitionError` из глубины.
 */
export function requiredStatusFor(action: ManualFulfillmentAction): OrderStatus {
  return action === 'start' ? 'failed' : 'in_fulfillment';
}

export function targetStatusFor(action: ManualFulfillmentAction): OrderStatus {
  return action === 'start' ? 'in_fulfillment' : 'completed';
}

export function eventTypeFor(action: ManualFulfillmentAction): string {
  return action === 'start' ? MANUAL_FULFILLMENT_STARTED : MANUAL_FULFILLMENT_COMPLETED;
}
