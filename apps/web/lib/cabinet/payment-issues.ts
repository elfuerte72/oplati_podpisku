/**
 * Типы проблем «Не проходит оплата?» (ТЗ «клиентский путь» §6) и чек-лист
 * самопроверки. Модуль без `server-only` — используется и клиентом Mini App
 * (выбор типа проблемы), и сервером (сообщение оператору).
 */

export const PAYMENT_ISSUE_TYPES = ['card_declined', 'wrong_amount', 'vpn_issue', 'other'] as const;

export type PaymentIssueType = (typeof PAYMENT_ISSUE_TYPES)[number];

export const PAYMENT_ISSUE_LABELS: Record<PaymentIssueType, string> = {
  card_declined: 'Карта отклоняется при оплате',
  wrong_amount: 'Сумма отличается / не хватает средств',
  vpn_issue: 'Не получается с VPN или локацией',
  other: 'Другая проблема',
};

/**
 * «Проблема с оплатой» — фаза ДО выпуска карты (антифрод-трек, тикет 10):
 * рублёвая оплата не подтвердилась. Отдельный словарь от `PAYMENT_ISSUE_TYPES`
 * (те — про фазу ПОСЛЕ выпуска: «карта не проходит на сайте сервиса»).
 */
export const PAYMENT_PROBLEM_TYPES = ['not_confirmed', 'refund_request', 'other'] as const;

export type PaymentProblemType = (typeof PAYMENT_PROBLEM_TYPES)[number];

export const PAYMENT_PROBLEM_LABELS: Record<PaymentProblemType, string> = {
  not_confirmed: 'Я оплатил, но заказ не подтвердился',
  refund_request: 'Хочу возврат',
  other: 'Другая проблема',
};

/** Событие в `order_events` — оно же ключ дедупа повторных нажатий (1 час). */
export const PAYMENT_PROBLEM_EVENT = 'payment_problem_reported';

/** Чек-лист самопроверки перед обращением в поддержку — пункты из ТЗ §6. */
export const PAYMENT_ISSUE_CHECKLIST: readonly string[] = [
  'Правильная ли локация VPN?',
  'Совпадает ли валюта на сайте сервиса?',
  'Хватает ли средств на карте?',
  'Верно ли введены номер, срок, CVC и billing-данные?',
  'Попробуй открыть сайт сервиса в приватной вкладке (инкогнито).',
];
