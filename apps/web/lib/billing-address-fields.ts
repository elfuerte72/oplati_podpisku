import type { BillingAddress } from '@oplati/types';

/**
 * Поля адреса плательщика с подписями — ОДИН словарь на два канала выдачи:
 * сообщение бота с картой (`formatBillingAddressLines` в `billing-address.ts`)
 * и лист реквизитов Mini App (трек miniapp-tabs, тикет 07).
 *
 * Отдельным модулем, а не функцией в `billing-address.ts`: тот тянет
 * `node:crypto` и `@oplati/db`, и в браузерный бандл его не взять. Подписи —
 * по-английски, как в форме оплаты сервиса: клиент ищет глазами ровно их.
 */
export type BillingAddressField = { label: string; value: string };

export function billingAddressFields(address: BillingAddress): BillingAddressField[] {
  return [
    { label: 'Street address', value: address.streetLine1 },
    { label: 'City', value: address.city },
    { label: 'State', value: `${address.state} (${address.stateCode})` },
    { label: 'ZIP', value: address.postalCode },
    { label: 'Country', value: address.country },
  ];
}
