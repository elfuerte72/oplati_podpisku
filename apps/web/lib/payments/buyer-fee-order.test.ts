import { describe, expect, it } from 'vitest';

// serverEnv кэшируется на файл: комиссия покупателя Freekassa = 7%, чтобы
// отличаться и от нуля L&P, и от дефолта схемы.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.FREEKASSA_BUYER_FEE_PERCENT = '7';
// Деньги СЕЙЧАС принимает L&P (комиссию покупателя он не добавляет).
process.env.PAYMENT_PRIMARY_PROVIDER = 'loveandpay';

import { buyerFeePercentForOrder } from './gateway.ts';

type PaymentLike = Parameters<typeof buyerFeePercentForOrder>[0][number];

function payment(over: Partial<PaymentLike> = {}): PaymentLike {
  return {
    provider: 'freekassa',
    status: 'pending',
    createdAt: new Date('2026-08-10T10:00:00.000Z'),
    ...over,
  };
}

/**
 * Комиссия плательщика — от шлюза, который ВЫСТАВИЛ счёт (аудит 2026-08-10).
 * Переключение `PAYMENT_PRIMARY_PROVIDER` не меняет условия по уже созданному
 * счёту: клиент уходит по ссылке прежнего провайдера, а в истории заказа цифра
 * должна остаться той, по которой он реально платил.
 */
describe('buyerFeePercentForOrder', () => {
  it('РЕГРЕСС: счёт выставлен Freekassa, шлюз уже переключён — берём комиссию Freekassa', () => {
    expect(buyerFeePercentForOrder([payment()])).toBe(7);
  });

  it('РЕГРЕСС: оплаченный заказ помнит шлюз своего платежа, а не текущий', () => {
    // Находка ревью: учёт только `pending` заставлял завершённый заказ
    // рассказывать про надбавку текущего шлюза — то есть про чужую сделку.
    expect(buyerFeePercentForOrder([payment({ status: 'succeeded' })])).toBe(7);
  });

  it('живой pending важнее старого провалившегося платежа', () => {
    const fee = buyerFeePercentForOrder([
      payment({
        provider: 'freekassa',
        status: 'failed',
        createdAt: new Date('2026-08-10T09:00:00.000Z'),
      }),
      payment({
        provider: 'loveandpay',
        status: 'pending',
        createdAt: new Date('2026-08-10T11:00:00.000Z'),
      }),
    ]);
    expect(fee).toBe(0);
  });

  it('среди исторических платежей берём самый свежий', () => {
    const fee = buyerFeePercentForOrder([
      payment({
        provider: 'loveandpay',
        status: 'failed',
        createdAt: new Date('2026-08-10T09:00:00.000Z'),
      }),
      payment({
        provider: 'freekassa',
        status: 'succeeded',
        createdAt: new Date('2026-08-10T12:00:00.000Z'),
      }),
    ]);
    expect(fee).toBe(7);
  });

  it('счёта нет вовсе — комиссия текущего шлюза (он его и выставит)', () => {
    expect(buyerFeePercentForOrder([])).toBe(0);
  });

  it('исторический провайдер вне списка шлюзов не ломает расчёт', () => {
    expect(buyerFeePercentForOrder([payment({ provider: 'manual' })])).toBe(0);
  });
});
