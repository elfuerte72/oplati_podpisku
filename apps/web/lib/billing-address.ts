import { z } from 'zod';

import { fetchJsonWithTimeout } from './http.ts';
import { childLogger } from './logger.ts';

const log = childLogger('billing-address');

const RANDOM_USER_URL = 'https://randomuser.me/api/1.4/?nat=us&inc=location&noinfo';
const RANDOM_USER_TIMEOUT_MS = 4_000;

export type BillingAddress = {
  streetLine1: string;
  city: string;
  state: string;
  stateCode: string | null;
  postalCode: string;
  country: 'United States';
  countryCode: 'US';
};

const randomUserLocationSchema = z.object({
  results: z
    .array(
      z.object({
        location: z.object({
          street: z.object({
            number: z.number(),
            name: z.string().min(1),
          }),
          city: z.string().min(1),
          state: z.string().min(1),
          country: z.string().min(1),
          postcode: z.union([z.string(), z.number()]),
        }),
      }),
    )
    .min(1),
});

const US_STATE_CODES: Record<string, string> = {
  Alabama: 'AL',
  Alaska: 'AK',
  Arizona: 'AZ',
  Arkansas: 'AR',
  California: 'CA',
  Colorado: 'CO',
  Connecticut: 'CT',
  Delaware: 'DE',
  Florida: 'FL',
  Georgia: 'GA',
  Hawaii: 'HI',
  Idaho: 'ID',
  Illinois: 'IL',
  Indiana: 'IN',
  Iowa: 'IA',
  Kansas: 'KS',
  Kentucky: 'KY',
  Louisiana: 'LA',
  Maine: 'ME',
  Maryland: 'MD',
  Massachusetts: 'MA',
  Michigan: 'MI',
  Minnesota: 'MN',
  Mississippi: 'MS',
  Missouri: 'MO',
  Montana: 'MT',
  Nebraska: 'NE',
  Nevada: 'NV',
  'New Hampshire': 'NH',
  'New Jersey': 'NJ',
  'New Mexico': 'NM',
  'New York': 'NY',
  'North Carolina': 'NC',
  'North Dakota': 'ND',
  Ohio: 'OH',
  Oklahoma: 'OK',
  Oregon: 'OR',
  Pennsylvania: 'PA',
  'Rhode Island': 'RI',
  'South Carolina': 'SC',
  'South Dakota': 'SD',
  Tennessee: 'TN',
  Texas: 'TX',
  Utah: 'UT',
  Vermont: 'VT',
  Virginia: 'VA',
  Washington: 'WA',
  'West Virginia': 'WV',
  Wisconsin: 'WI',
  Wyoming: 'WY',
};

const FALLBACK_US_ADDRESSES: readonly [BillingAddress, ...BillingAddress[]] = [
  {
    streetLine1: '350 5th Ave',
    city: 'New York',
    state: 'New York',
    stateCode: 'NY',
    postalCode: '10118',
    country: 'United States',
    countryCode: 'US',
  },
  {
    streetLine1: '1 Market St',
    city: 'San Francisco',
    state: 'California',
    stateCode: 'CA',
    postalCode: '94105',
    country: 'United States',
    countryCode: 'US',
  },
  {
    streetLine1: '600 Congress Ave',
    city: 'Austin',
    state: 'Texas',
    stateCode: 'TX',
    postalCode: '78701',
    country: 'United States',
    countryCode: 'US',
  },
];

/**
 * Random User Generator — бесплатный публичный API без ключа. Это не
 * критичный dependency: при ошибке возвращаем локальный публичный US-адрес,
 * чтобы выдача карты не зависела от стороннего сервиса.
 */
export async function getRandomUsBillingAddress(): Promise<BillingAddress> {
  try {
    // fetchJsonWithTimeout, а не fetchWithTimeout: второй снимает таймаут ещё
    // до чтения тела, и сторонний сервис, отдавший заголовки и замолчавший,
    // вешал бы выпуск карты — уже после приёма рублей (ревью 2026-08-11).
    const data = await fetchJsonWithTimeout(
      RANDOM_USER_URL,
      { headers: { Accept: 'application/json' } },
      randomUserLocationSchema,
      RANDOM_USER_TIMEOUT_MS,
    );
    if (!data) {
      throw new Error('randomuser: ответ недоступен или не соответствует контракту');
    }

    const first = data.results[0];
    if (!first) {
      throw new Error('randomuser returned no results');
    }
    const { location } = first;
    return {
      streetLine1: `${location.street.number} ${location.street.name}`,
      city: location.city,
      state: location.state,
      stateCode: US_STATE_CODES[location.state] ?? null,
      postalCode: String(location.postcode),
      country: 'United States',
      countryCode: 'US',
    };
  } catch (err) {
    log.warn({ event: 'billing_address.randomuser_fallback', err });
    return fallbackAddress();
  }
}

export function formatBillingAddressLines(address: BillingAddress): string[] {
  return [
    `Street address: ${address.streetLine1}`,
    `City: ${address.city}`,
    `State: ${formatState(address)}`,
    `ZIP: ${address.postalCode}`,
    `Country: ${address.country}`,
  ];
}

function formatState(address: BillingAddress): string {
  return address.stateCode ? `${address.state} (${address.stateCode})` : address.state;
}

function fallbackAddress(): BillingAddress {
  const index = Math.floor(Math.random() * FALLBACK_US_ADDRESSES.length);
  return FALLBACK_US_ADDRESSES[index] ?? FALLBACK_US_ADDRESSES[0];
}
