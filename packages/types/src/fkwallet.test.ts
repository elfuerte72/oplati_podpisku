import { describe, expect, it } from 'vitest';

import { fkWalletBalanceResponseSchema, fkWalletErrorResponseSchema } from './fkwallet.ts';

/**
 * Контракт кошелька FKWallet снят из OpenAPI-схемы, живым вызовом не
 * подтверждён, и схема написана небрежно — поэтому Zod принимает все формы,
 * которые из неё можно прочитать, и тест закрепляет каждую.
 */
describe('fkWalletBalanceResponseSchema', () => {
  it('список балансов, числа наружу строкой', () => {
    const parsed = fkWalletBalanceResponseSchema.parse({
      status: 'ok',
      data: [
        { currency_code: 'RUB', value: 15000.5 },
        { currency_code: 'USDT', value: '12.3' },
      ],
    });
    expect(parsed.data).toEqual([
      { currency_code: 'RUB', value: '15000.5' },
      { currency_code: 'USDT', value: '12.3' },
    ]);
  });

  it('один объект вместо списка (так описано в схеме доки) — тоже список', () => {
    const parsed = fkWalletBalanceResponseSchema.parse({
      status: 'ok',
      data: { currency_code: 'RUB', value: 100 },
    });
    expect(parsed.data).toEqual([{ currency_code: 'RUB', value: '100' }]);
  });

  it('обёртка { data: { status, data } } снимается', () => {
    const parsed = fkWalletBalanceResponseSchema.parse({
      data: { status: 'ok', data: [{ currency_code: 'USDT', value: '1' }] },
    });
    expect(parsed.status).toBe('ok');
    expect(parsed.data).toEqual([{ currency_code: 'USDT', value: '1' }]);
  });

  it('отказ провайдера балансом не считается, а ошибкой — да', () => {
    const body = { status: 'error', message: 'Wrong sign' };
    expect(fkWalletBalanceResponseSchema.safeParse(body).success).toBe(false);
    expect(fkWalletErrorResponseSchema.parse(body)).toMatchObject({ status: 'error', message: 'Wrong sign' });
  });

  it('status ok ошибкой не считается', () => {
    expect(fkWalletErrorResponseSchema.safeParse({ status: 'ok', data: [] }).success).toBe(false);
  });
});
