/**
 * Что показывает вкладка «Карта» Mini App (трек miniapp-tabs, тикет 06).
 *
 * Главное после оплаты — шаг 3: «оплати сервис этой картой». До вкладок его
 * экран открывался только через красную ссылку «Не проходит оплата?», и из
 * восьми оплативших «Подписка оформлена» не нажал никто. Поэтому здесь правило,
 * КОГДА этот шаг показывать, вынесено в чистую функцию с тестами: спрятать его
 * от того, кто его не сделал, — потерять клиента на последнем метре; вечно
 * показывать тому, кто давно оформил, — превратить подсказку в шум.
 */

import {
  ISSUE_FAILED_MAX_AGE_MS,
  isRecentIssueFailure,
  type IssueFailedOrderLike,
} from './issue-failed';

/** Сколько дней после заказа ещё напоминаем про шаг 3. */
export const NEXT_STEP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Сколько заказ «в выпуске» может заслонять рабочую карту. Обычно выпуск —
 * минуты; заказ, застрявший на часы (ручная выдача), не должен бессрочно
 * прятать карту клиента и её «Остался один шаг» за «Выпускаю карту…». Без
 * рабочей карты показать больше нечего — тогда выпуск виден как есть.
 */
export const ISSUING_OVER_CARD_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Статусы «деньги пришли, карта в пути». */
const ISSUING_STATUSES = new Set(['paid', 'in_fulfillment']);

export type CardTabOrderLike = IssueFailedOrderLike & {
  orderId: string;
  status: string;
  createdAt: string;
  /**
   * Карта, выданная по заказу. Необязательное: снапшот сервера прошлого деплоя
   * поля не несёт, и такой заказ просто не относится ни к одной карте.
   */
  cardId?: string | null | undefined;
  /** Клиент отметил «Подписка оформлена» (событие `subscription_activated`). */
  subscriptionActivated?: boolean | undefined;
};

export type CardTabCardLike = { id: string; status: string; createdAt: string };

export type CardTabState<O extends CardTabOrderLike, C extends CardTabCardLike> =
  | { kind: 'none' }
  | {
      kind: 'issuing';
      order: O;
      /** Деньги ложатся на уже выпущенную активную карту (второй сервис). */
      topUp: boolean;
    }
  | {
      /** Оплачен, а выдача упала: разбирается оператор (`isPaidButIssueFailed`). */
      kind: 'issue_failed';
      order: O;
    }
  | {
      kind: 'active';
      card: C;
      /** Заказ, по которому клиент ещё не оформил подписку; null — шаг сделан. */
      nextStep: O | null;
      /** Выполненные заказы по этой карте, свежие сверху. */
      cardOrders: O[];
    };

const byCreatedDesc = (a: { createdAt: string }, b: { createdAt: string }) =>
  b.createdAt.localeCompare(a.createdAt);

export function selectCardTabState<O extends CardTabOrderLike, C extends CardTabCardLike>(
  snapshot: { orders: readonly O[]; cards: readonly C[] },
  now: number = Date.now(),
): CardTabState<O, C> {
  const { orders, cards } = snapshot;
  const hasActiveCard = cards.some((c) => c.status === 'active');

  // Выпуск важнее готовой карты: только что оплативший ждёт именно эту карту,
  // и показать ему прошлую с «остался один шаг» по прошлому сервису — сбить.
  // Но не бессрочно: застрявший выпуск через несколько часов уступает карте.
  const issuing = [...orders]
    .filter(
      (o) =>
        ISSUING_STATUSES.has(o.status) &&
        !(o.cardId && cards.some((c) => c.id === o.cardId)) &&
        (!hasActiveCard || now - Date.parse(o.createdAt) <= ISSUING_OVER_CARD_MAX_AGE_MS),
    )
    .sort(byCreatedDesc)[0];
  if (issuing) {
    return { kind: 'issuing', order: issuing, topUp: hasActiveCard };
  }

  // Выдача сорвалась после оплаты. Без этой ветки «Выпускаю карту…» сменялось
  // «Карты пока нет» (или прошлой картой с шагом по прошлому сервису): только
  // что заплативший клиент видел пустоту. Поверх рабочей карты — не дольше, чем
  // выпуск (иначе карта недоступна с вкладки), без неё — до `ISSUE_FAILED_MAX_AGE_MS`.
  // Возраст — от оплаты (`isRecentIssueFailure`), не от создания заказа.
  const issueFailed = [...orders]
    .filter(
      (o) =>
        isRecentIssueFailure(
          o,
          now,
          hasActiveCard ? ISSUING_OVER_CARD_MAX_AGE_MS : ISSUE_FAILED_MAX_AGE_MS,
        ) && !(o.cardId && cards.some((c) => c.id === o.cardId)),
    )
    .sort(byCreatedDesc)[0];
  if (issueFailed) {
    return { kind: 'issue_failed', order: issueFailed };
  }

  // Основная карта — свежая активная; активной нет — свежая по выпуску.
  // Сортируем сами, а не полагаемся на порядок из репозитория.
  const newestFirst = [...cards].sort(byCreatedDesc);
  const card = newestFirst.find((c) => c.status === 'active') ?? newestFirst[0] ?? null;
  if (!card) return { kind: 'none' };

  const cardOrders = orders
    .filter((o) => o.status === 'completed' && o.cardId === card.id)
    .sort(byCreatedDesc);

  // Решает ПОСЛЕДНИЙ заказ по карте: отметку ставят по свежему сервису, и
  // старый неотмеченный заказ не должен всплывать поверх неё.
  const latest = cardOrders[0];
  const nextStep =
    latest &&
    latest.subscriptionActivated !== true &&
    now - Date.parse(latest.createdAt) <= NEXT_STEP_MAX_AGE_MS
      ? latest
      : null;

  return { kind: 'active', card, nextStep, cardOrders };
}
