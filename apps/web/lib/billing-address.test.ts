import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { BILLING_ADDRESS_POOL, billingAddressForUser, formatBillingAddressLines } from './billing-address.ts';

/**
 * Правила пула billing-адресов. Существование самих зданий тест проверить не
 * может (это сеть) — для него есть `scripts/verify-billing-addresses.ts`. Здесь
 * держится то, что ломается ОПЕЧАТКОЙ при добавлении адреса: ZIP чужого штата —
 * ровно тот дефект, из-за которого сервисы отвергали адреса `randomuser.me`.
 */

/**
 * Штаты БЕЗ налога с продаж и диапазон первых трёх цифр их ZIP (зоны USPS).
 * Штат вне списка в пул не попадает: налог сервис добавил бы к цене сверху, и
 * он съедал бы буфер карты, рассчитанный на FX и VAT.
 */
const NO_SALES_TAX_STATES: Record<string, { name: string; zipPrefix: [number, number] }> = {
  AK: { name: 'Alaska', zipPrefix: [995, 999] },
  DE: { name: 'Delaware', zipPrefix: [197, 199] },
  MT: { name: 'Montana', zipPrefix: [590, 599] },
  NH: { name: 'New Hampshire', zipPrefix: [30, 38] },
  OR: { name: 'Oregon', zipPrefix: [970, 979] },
};

describe('пул billing-адресов', () => {
  it.each(BILLING_ADDRESS_POOL.map((a) => [`${a.streetLine1}, ${a.city}`, a] as const))(
    '%s — штат без налога с продаж, ZIP из диапазона этого штата',
    (_label, address) => {
      const state = NO_SALES_TAX_STATES[address.stateCode];
      expect(state, `штат ${address.stateCode} облагает продажи налогом или не из США`).toBeDefined();
      if (!state) return;

      expect(address.state).toBe(state.name);
      expect(address.postalCode).toMatch(/^\d{5}$/);

      const prefix = Number(address.postalCode.slice(0, 3));
      const [from, to] = state.zipPrefix;
      expect(
        prefix >= from && prefix <= to,
        `ZIP ${address.postalCode} не принадлежит штату ${address.stateCode}`,
      ).toBe(true);
    },
  );

  it('номер дома стоит первым — так его ждут формы оплаты и сверка адреса у банка', () => {
    for (const address of BILLING_ADDRESS_POOL) {
      expect(address.streetLine1).toMatch(/^\d+ \S/);
    }
  });

  it('адресов-дублей нет', () => {
    const keys = BILLING_ADDRESS_POOL.map((a) => `${a.streetLine1}|${a.postalCode}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('billingAddressForUser', () => {
  it('один клиент — один адрес: повторный выпуск карты не меняет адрес, привязанный у сервиса', () => {
    const userId = randomUUID();

    expect(billingAddressForUser(userId)).toBe(billingAddressForUser(userId));
  });

  it('клиенты расходятся по ВСЕМУ пулу, а не складываются в пару адресов', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(billingAddressForUser(randomUUID()).streetLine1);

    expect(seen.size).toBe(BILLING_ADDRESS_POOL.length);
  });

  it('любая строка даёт адрес из пула — выбор не может упасть после приёма рублей', () => {
    for (const userId of ['', 'user-1', 'не-uuid', '0']) {
      expect(BILLING_ADDRESS_POOL).toContain(billingAddressForUser(userId));
    }
  });
});

describe('formatBillingAddressLines', () => {
  it('отдаёт строки в том порядке, в каком их спрашивает форма оплаты', () => {
    expect(formatBillingAddressLines(BILLING_ADDRESS_POOL[0])).toEqual([
      'Street address: 801 SW 10th Ave',
      'City: Portland',
      'State: Oregon (OR)',
      'ZIP: 97205',
      'Country: United States',
    ]);
  });
});
