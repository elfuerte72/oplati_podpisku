import { describe, expect, it } from 'vitest';

import { buildCatalogService, computeTotalKopecks, sortCatalog } from './build';

const RATE = 95.5; // RUB за USDT
const COMMISSION = 10; // %

function row(overrides: Partial<Parameters<typeof buildCatalogService>[0]> = {}) {
  return {
    slug: 'claude-pro',
    name: 'Claude Pro',
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        { name: 'Pro', period: 'month', priceRub: 253000, originalAmount: 2000, currency: 'USD' },
      ],
      margin: 0.15,
    },
    ...overrides,
  };
}

describe('computeTotalKopecks', () => {
  it('повторяет формулу propose_order: округление subtotal и комиссии раздельно', () => {
    // $20 × 95.5 = 1910.00 RUB → 191000 коп; комиссия 10% → 19100; итог 210100
    expect(computeTotalKopecks(2000, RATE, COMMISSION)).toBe(210_100);
  });

  it('округляет дробные копейки до integer', () => {
    // 1099 × 95.5 = 104954.5 → 104955 (round даёт integer уже на subtotal)
    const total = computeTotalKopecks(1099, RATE, COMMISSION);
    expect(Number.isInteger(total)).toBe(true);
    expect(total).toBe(104_955 + Math.round(104_955 / 10));
  });
});

describe('buildCatalogService', () => {
  it('возвращает тариф с рублёвой оценкой для обычного сервиса', () => {
    const svc = buildCatalogService(row(), RATE, COMMISSION);
    expect(svc).not.toBeNull();
    expect(svc?.customAmount).toBe(false);
    expect(svc?.tiers).toEqual([
      { name: 'Pro', period: 'month', usdCents: 2000, totalKopecks: 210_100 },
    ]);
  });

  it('dummy-tier (originalAmount ≤ 1) → customAmount без тарифов (Airbnb)', () => {
    const svc = buildCatalogService(
      row({
        slug: 'airbnb',
        pricingPolicy: {
          tiers: [
            { name: 'Booking', period: 'month', priceRub: 1, originalAmount: 1, currency: 'USD' },
          ],
        },
      }),
      RATE,
      COMMISSION,
    );
    expect(svc?.customAmount).toBe(true);
    expect(svc?.tiers).toEqual([]);
  });

  it('невалидная pricing_policy → null', () => {
    expect(buildCatalogService(row({ pricingPolicy: { tiers: [] } }), RATE, COMMISSION)).toBeNull();
    expect(buildCatalogService(row({ pricingPolicy: null }), RATE, COMMISSION)).toBeNull();
  });

  it('не-USD тарифы отбрасываются; если пригодных нет — null', () => {
    const svc = buildCatalogService(
      row({
        pricingPolicy: {
          tiers: [
            { name: 'EU', period: 'month', priceRub: 1000, originalAmount: 999, currency: 'EUR' },
          ],
        },
      }),
      RATE,
      COMMISSION,
    );
    expect(svc).toBeNull();
  });
});

describe('sortCatalog', () => {
  it('популярные — в заданном порядке, остальные по алфавиту следом', () => {
    const mk = (slug: string, name: string) => ({
      slug,
      name,
      category: 'x',
      requiresKyc: false,
      customAmount: false,
      tiers: [],
    });
    const sorted = sortCatalog([
      mk('notion-plus', 'Notion Plus'),
      mk('claude-pro', 'Claude Pro'),
      mk('airbnb', 'Airbnb'),
      mk('chatgpt-plus', 'ChatGPT Plus'),
    ]);
    expect(sorted.map((s) => s.slug)).toEqual([
      'chatgpt-plus',
      'claude-pro',
      'airbnb',
      'notion-plus',
    ]);
  });
});
