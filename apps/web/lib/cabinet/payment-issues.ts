/**
 * Типы проблем «Не проходит оплата?» (ТЗ «клиентский путь» §6) и чек-лист
 * самопроверки. Модуль без `server-only` — используется и клиентом Mini App
 * (выбор типа проблемы), и сервером (сообщение оператору).
 */

export const PAYMENT_ISSUE_LABELS = {
  card_declined: 'Карта отклоняется при оплате',
  wrong_amount: 'Сумма отличается / не хватает средств',
  vpn_issue: 'Не получается с VPN или локацией',
  other: 'Другая проблема',
} as const;

export type PaymentIssueType = keyof typeof PAYMENT_ISSUE_LABELS;

export const PAYMENT_ISSUE_TYPES = Object.keys(PAYMENT_ISSUE_LABELS) as PaymentIssueType[];

/** Чек-лист самопроверки перед обращением в поддержку — пункты из ТЗ §6. */
export const PAYMENT_ISSUE_CHECKLIST: readonly string[] = [
  'Правильная ли локация VPN?',
  'Совпадает ли валюта на сайте сервиса?',
  'Хватает ли средств на карте?',
  'Верно ли введены номер, срок, CVC и billing-данные?',
  'Попробуй открыть сайт сервиса в приватной вкладке (инкогнито).',
];
