import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BillingAddress } from '@oplati/types';

const h = vi.hoisted(() => ({
  assign: vi.fn<(db: unknown, input: { userId: string; candidate: unknown }) => Promise<unknown>>(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('@oplati/db', () => ({ getOrAssignUserBillingAddress: h.assign }));
vi.mock('@sentry/nextjs', () => ({
  captureException: h.captureException,
  captureMessage: h.captureMessage,
}));

import {
  BILLING_ADDRESS_POOL,
  formatBillingAddressLines,
  pickRandomBillingAddress,
  resolveBillingAddressForUser,
} from './billing-address.ts';

const DB = {} as Parameters<typeof resolveBillingAddressForUser>[0];

beforeEach(() => {
  h.assign.mockReset();
  h.captureException.mockClear();
  h.captureMessage.mockClear();
});

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

describe('pickRandomBillingAddress', () => {
  it('выпадают ВСЕ адреса пула, а не пара первых', () => {
    const seen = new Set<BillingAddress>();
    for (let i = 0; i < 500; i++) seen.add(pickRandomBillingAddress());

    expect(seen.size).toBe(BILLING_ADDRESS_POOL.length);
  });
});

describe('resolveBillingAddressForUser', () => {
  it('первый заказ: случайный адрес из пула уходит на закрепление, клиент получает закреплённый', async () => {
    h.assign.mockImplementation(async (_db, input) => input.candidate);

    const address = await resolveBillingAddressForUser(DB, 'user-1');

    expect(h.assign).toHaveBeenCalledWith(DB, { userId: 'user-1', candidate: address });
    expect(BILLING_ADDRESS_POOL).toContain(address);
  });

  it('следующий заказ: клиент получает УЖЕ закреплённый адрес, а не свежий случайный', async () => {
    // Адреса нет в пуле намеренно: закреплённый снимок живёт своей жизнью, и
    // правка пула не должна менять адрес обслуженному клиенту.
    const pinned: BillingAddress = {
      streetLine1: '1 Old Pool St',
      city: 'Dover',
      state: 'Delaware',
      stateCode: 'DE',
      postalCode: '19901',
      country: 'United States',
      countryCode: 'US',
    };
    h.assign.mockResolvedValue(pinned);

    expect(await resolveBillingAddressForUser(DB, 'user-1')).toBe(pinned);
  });

  it('БД упала — клиент всё равно получает настоящий адрес, а сбой уходит в Sentry', async () => {
    // Вызывается после приёма рублей: сбой вспомогательного шага не должен
    // стоить клиенту карты.
    h.assign.mockRejectedValue(new Error('connection refused'));

    const address = await resolveBillingAddressForUser(DB, 'user-1');

    expect(BILLING_ADDRESS_POOL).toContain(address);
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('в колонке лежит нечитаемая строка — адрес из пула и громкий сигнал, а не тишина', async () => {
    h.assign.mockResolvedValue(null);

    const address = await resolveBillingAddressForUser(DB, 'user-1');

    expect(BILLING_ADDRESS_POOL).toContain(address);
    expect(h.captureMessage).toHaveBeenCalledTimes(1);
  });
});

describe('formatBillingAddressLines', () => {
  it('отдаёт строки в том порядке, в каком их спрашивает форма оплаты', () => {
    expect(formatBillingAddressLines(BILLING_ADDRESS_POOL[0])).toEqual([
      'Street address: 201 W 36th Ave',
      'City: Anchorage',
      'State: Alaska (AK)',
      'ZIP: 99503',
      'Country: United States',
    ]);
  });
});
