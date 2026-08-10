import { describe, expect, it } from 'vitest';

import {
  buildCatalogService,
  computeTotalKopecks,
  filterCatalogForDisplay,
  groupCatalog,
  sortCatalog,
} from './build';

const RATE = 95.5; // RUB за USDT
const COMMISSION = 10; // %
const MIN_KOPECKS = 50_000; // пол 500 ₽ (orderFloorRub() × 100)

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
    // (уже целые рубли — округлять вверх нечего).
    expect(computeTotalKopecks(2000, RATE, COMMISSION)).toBe(210_100);
  });

  it('цена без копеек: итог округляется ВВЕРХ до целого рубля', () => {
    // 1099 × 95.5 = 104954.5 → subtotal 104955; комиссия 10% → 10496;
    // сумма 115451 коп. (1154,51 ₽) → вверх до 115500 коп. (1155 ₽).
    const total = computeTotalKopecks(1099, RATE, COMMISSION);
    expect(total).toBe(115_500);
    expect(total % 100).toBe(0);
    // Округление именно в нашу сторону — итог не меньше сырой суммы.
    expect(total).toBeGreaterThanOrEqual(104_955 + 10_496);
  });
});

describe('buildCatalogService', () => {
  it('возвращает тариф с рублёвой оценкой для обычного сервиса', () => {
    const svc = buildCatalogService(row(), RATE, COMMISSION, MIN_KOPECKS);
    expect(svc).not.toBeNull();
    expect(svc?.customAmount).toBe(false);
    expect(svc?.tiers).toEqual([
      { name: 'Pro', period: 'month', usdCents: 2000, totalKopecks: 210_100 },
    ]);
  });

  it('сохраняет 3-месячный период тарифа', () => {
    const svc = buildCatalogService(
      row({
        slug: 'playstation-plus',
        pricingPolicy: {
          tiers: [
            { name: 'Essential', period: 'quarter', priceRub: 1, originalAmount: 2799, currency: 'USD' },
          ],
        },
      }),
      RATE,
      COMMISSION,
      MIN_KOPECKS,
    );

    expect(svc?.tiers).toEqual([
      // 2799 × 95.5 = 267 305 (round) + 10% = 294 036 → вверх до 294 100 (2941 ₽).
      { name: 'Essential', period: 'quarter', usdCents: 2799, totalKopecks: 294_100 },
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
      MIN_KOPECKS,
    );
    expect(svc?.customAmount).toBe(true);
    expect(svc?.tiers).toEqual([]);
  });

  it('прокидывает payment_instructions в витрину (ТЗ §5)', () => {
    const svc = buildCatalogService(
      row({
        paymentInstructions: {
          requiresVpn: true,
          vpnLocation: 'США',
          requiredCurrency: 'USD',
          paymentUrl: 'https://claude.ai/upgrade',
        },
      }),
      RATE,
      COMMISSION,
      MIN_KOPECKS,
    );
    expect(svc?.instructions).toEqual({
      requiresVpn: true,
      vpnLocation: 'США',
      requiredCurrency: 'USD',
      paymentUrl: 'https://claude.ai/upgrade',
    });
  });

  it('битые/отсутствующие payment_instructions НЕ прячут сервис — instructions: null', () => {
    const broken = buildCatalogService(
      row({ paymentInstructions: { vpnLocation: 'США' } }), // нет requiresVpn
      RATE,
      COMMISSION,
      MIN_KOPECKS,
    );
    expect(broken).not.toBeNull();
    expect(broken?.instructions).toBeNull();

    const missing = buildCatalogService(row(), RATE, COMMISSION, MIN_KOPECKS);
    expect(missing?.instructions).toBeNull();
  });

  it('невалидная pricing_policy → null', () => {
    expect(buildCatalogService(row({ pricingPolicy: { tiers: [] } }), RATE, COMMISSION, MIN_KOPECKS)).toBeNull();
    expect(buildCatalogService(row({ pricingPolicy: null }), RATE, COMMISSION, MIN_KOPECKS)).toBeNull();
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
      MIN_KOPECKS,
    );
    expect(svc).toBeNull();
  });

  it('тарифы ниже пола 500 ₽ отфильтрованы (iCloud: $0.99 убрать, $9.99 оставить)', () => {
    const svc = buildCatalogService(
      row({
        slug: 'icloud-plus-200gb',
        pricingPolicy: {
          tiers: [
            { name: '50GB', period: 'month', priceRub: 1, originalAmount: 99, currency: 'USD' },
            { name: '2TB', period: 'month', priceRub: 1, originalAmount: 999, currency: 'USD' },
          ],
        },
      }),
      RATE,
      COMMISSION,
      MIN_KOPECKS,
    );
    expect(svc?.tiers.map((t) => t.name)).toEqual(['2TB']); // $0.99 (~104 ₽) выкинут
  });

  it('все тарифы ниже пола → сервис не показываем (null)', () => {
    const svc = buildCatalogService(
      row({
        slug: 'icloud-cheap',
        pricingPolicy: {
          tiers: [
            { name: '50GB', period: 'month', priceRub: 1, originalAmount: 99, currency: 'USD' },
          ],
        },
      }),
      RATE,
      COMMISSION,
      MIN_KOPECKS,
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
      instructions: null,
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

describe('filterCatalogForDisplay', () => {
  it('временно скрывает от пользователя отложенные сервисы, сохраняя остальные', () => {
    const mk = (slug: string, name: string) => ({
      slug,
      name,
      category: 'x',
      requiresKyc: false,
      customAmount: false,
      tiers: [],
      instructions: null,
    });

    const visible = filterCatalogForDisplay([
      mk('chatgpt-plus', 'ChatGPT'),
      mk('apple-music', 'Apple Music'),
      mk('apple-app-store', 'App Store (пополнение)'),
      mk('icloud-plus-200gb', 'iCloud+'),
      mk('telegram-premium', 'Telegram Premium'),
      mk('claude-pro', 'Claude'),
    ]);

    expect(visible.map((service) => service.slug)).toEqual(['chatgpt-plus', 'claude-pro']);
  });
});

describe('groupCatalog', () => {
  const mk = (slug: string, name: string, category: string) => ({
    slug,
    name,
    category,
    requiresKyc: false,
    customAmount: false,
    tiers: [],
    instructions: null,
  });

  it('группирует по темам в заданном порядке, внутри — по популярности', () => {
    const groups = groupCatalog([
      mk('telegram-premium', 'Telegram Premium', 'social'),
      mk('netflix-premium', 'Netflix', 'streaming'),
      mk('chatgpt-plus', 'ChatGPT', 'ai'),
      mk('xbox-game-pass', 'Xbox Game Pass', 'gaming'),
      mk('playstation-plus', 'PlayStation Plus', 'gaming'),
    ]);

    expect(groups.map((g) => [g.category, g.label])).toEqual([
      ['ai', 'Искусственный интеллект'],
      ['streaming', 'Стриминг и музыка'],
      ['gaming', 'Игры'],
      ['social', 'Общение'],
    ]);
    // gaming: PlayStation раньше Xbox по POPULAR_ORDER, несмотря на порядок входа.
    expect(groups.find((g) => g.category === 'gaming')?.services.map((s) => s.slug)).toEqual([
      'playstation-plus',
      'xbox-game-pass',
    ]);
  });

  it('неизвестная категория падает в хвост под собственным именем', () => {
    const groups = groupCatalog([
      mk('foo', 'Foo', 'mystery'),
      mk('chatgpt-plus', 'ChatGPT', 'ai'),
    ]);
    expect(groups.map((g) => g.category)).toEqual(['ai', 'mystery']);
    expect(groups[1]?.label).toBe('mystery');
  });
});
