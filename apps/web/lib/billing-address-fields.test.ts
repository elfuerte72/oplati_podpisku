import { describe, expect, it } from 'vitest';

import type { BillingAddress } from '@oplati/types';

import { billingAddressFields } from './billing-address-fields.ts';

/**
 * Подписи и значения адреса плательщика — ОДИН словарь на сообщение бота и
 * лист реквизитов Mini App (трек miniapp-tabs, тикет 07). Клиент копирует
 * строки по одной в форму сервиса, поэтому значение отдаётся без подписи.
 */

const ANCHORAGE: BillingAddress = {
  streetLine1: '201 W 36th Ave',
  city: 'Anchorage',
  state: 'Alaska',
  stateCode: 'AK',
  postalCode: '99503',
  country: 'United States',
  countryCode: 'US',
};

describe('billingAddressFields', () => {
  it('поля в порядке формы оплаты, подписи — как в сообщении бота', () => {
    expect(billingAddressFields(ANCHORAGE)).toEqual([
      { label: 'Street address', value: '201 W 36th Ave' },
      { label: 'City', value: 'Anchorage' },
      { label: 'State', value: 'Alaska (AK)' },
      { label: 'ZIP', value: '99503' },
      { label: 'Country', value: 'United States' },
    ]);
  });
});
