import { describe, expect, it } from 'vitest';

import { assertUniqueTierKeys, type ServiceTier } from './index.ts';

const tier = (over: Partial<ServiceTier>): ServiceTier => ({
  name: 'Individual',
  period: 'month',
  priceRub: 100_000,
  originalAmount: 1199,
  currency: 'USD',
  ...over,
});

/**
 * Тарифы ищут ДВУМЯ разными ключами: кнопка Telegram — по
 * `(period, originalAmount)` (L-20), а заказ в вебе и Mini App —
 * по `(name, period)` (`proposeFromCatalog`). Сид проверял только первый,
 * поэтому дубль по второму проходил насквозь и давал клиенту цену первого
 * совпавшего тарифа (аудит 2026-08-10).
 */
describe('assertUniqueTierKeys', () => {
  it('пропускает различимый каталог', () => {
    expect(() =>
      assertUniqueTierKeys('spotify', [
        tier({}),
        tier({ name: 'Duo', originalAmount: 1699 }),
        tier({ period: 'year', originalAmount: 11_999 }),
      ]),
    ).not.toThrow();
  });

  it('падает на дубле ключа кнопки Telegram', () => {
    expect(() =>
      assertUniqueTierKeys('spotify', [tier({}), tier({ name: 'Другое имя' })]),
    ).toThrow(/period, originalAmount/);
  });

  it('падает на дубле ключа матчинга заказа (name, period)', () => {
    // Именно этот случай сид пропускал: цены разные, значит ключ кнопки
    // различим, а `find` по имени и периоду возьмёт ПЕРВЫЙ тариф.
    expect(() =>
      assertUniqueTierKeys('spotify', [tier({}), tier({ originalAmount: 1699 })]),
    ).toThrow(/name, period/);
  });

  it('сообщение называет сервис — иначе дубль ищут по всему каталогу', () => {
    expect(() => assertUniqueTierKeys('netflix', [tier({}), tier({})])).toThrow(/netflix/);
  });
});
