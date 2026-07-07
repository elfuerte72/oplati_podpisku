import { describe, expect, it } from 'vitest';

import {
  confirmOrderInput,
  proposeOrderInput,
  requestHumanInput,
  searchCatalogInput,
} from './index.ts';

describe('AI tool input schemas (L6)', () => {
  describe('proposeOrderInput', () => {
    it('принимает валидный custom-заказ', () => {
      const r = proposeOrderInput.safeParse({
        customDescription: 'iCloud+ 200GB, 1 месяц',
        serviceName: 'iCloud+',
        amountUsdCents: 300,
        paymentMethod: 'sbp',
      });
      expect(r.success).toBe(true);
    });

    it('отклоняет customDescription длиннее 500 символов', () => {
      const r = proposeOrderInput.safeParse({
        customDescription: 'x'.repeat(501),
        amountUsdCents: 300,
      });
      expect(r.success).toBe(false);
    });

    it('отклоняет serviceName длиннее 100 символов', () => {
      const r = proposeOrderInput.safeParse({ serviceName: 'y'.repeat(101), amountUsdCents: 300 });
      expect(r.success).toBe(false);
    });

    it('требует положительный целочисленный amountUsdCents', () => {
      expect(proposeOrderInput.safeParse({ amountUsdCents: 0 }).success).toBe(false);
      expect(proposeOrderInput.safeParse({ amountUsdCents: -100 }).success).toBe(false);
      expect(proposeOrderInput.safeParse({ amountUsdCents: 10.5 }).success).toBe(false);
      expect(proposeOrderInput.safeParse({}).success).toBe(false);
    });
  });

  describe('requestHumanInput', () => {
    it('дефолтит orderId в null, когда не задан', () => {
      const r = requestHumanInput.safeParse({ reason: 'нужен человек' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.orderId).toBeNull();
    });

    it('отклоняет пустой reason', () => {
      expect(requestHumanInput.safeParse({ reason: '' }).success).toBe(false);
    });
  });

  describe('confirmOrderInput / searchCatalogInput', () => {
    it('confirm требует orderId', () => {
      expect(confirmOrderInput.safeParse({}).success).toBe(false);
      expect(confirmOrderInput.safeParse({ orderId: 'o1' }).success).toBe(true);
    });

    it('search требует непустой query', () => {
      expect(searchCatalogInput.safeParse({ query: '' }).success).toBe(false);
      expect(searchCatalogInput.safeParse({ query: 'claude' }).success).toBe(true);
    });
  });
});
