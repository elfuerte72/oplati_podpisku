import { describe, expect, it } from 'vitest';

import { rapiraMarketRateSchema, rapiraMarketRatesResponseSchema } from './rapira.ts';

const SUPPORT_SAMPLE = {
  data: [
    {
      symbol: 'USDT/RUB',
      askPrice: 80.88,
      bidPrice: 80.84,
      baseCurrency: 'RUB',
      quoteCurrency: 'USDT',
    },
  ],
  code: 0,
  message: 'SUCCESS',
  totalPage: null,
  totalElement: null,
  isWorking: 1,
};

describe('rapiraMarketRatesResponseSchema', () => {
  it('parses the Rapira support sample for USDT/RUB', () => {
    const parsed = rapiraMarketRatesResponseSchema.parse(SUPPORT_SAMPLE);

    expect(parsed.data[0]).toEqual({
      symbol: 'USDT/RUB',
      askPrice: 80.88,
      bidPrice: 80.84,
      baseCurrency: 'RUB',
      quoteCurrency: 'USDT',
    });
    expect(parsed.code).toBe(0);
    expect(parsed.isWorking).toBe(1);
  });

  it('rejects a non-positive ask price', () => {
    const result = rapiraMarketRateSchema.safeParse({
      ...SUPPORT_SAMPLE.data[0],
      askPrice: 0,
    });

    expect(result.success).toBe(false);
  });
});
