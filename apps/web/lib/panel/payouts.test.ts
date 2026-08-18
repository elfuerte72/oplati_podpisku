import { describe, expect, it } from 'vitest';

import { PAYOUT_STATUSES } from '@oplati/types';

import { isPayoutDecidable, payoutStatusLabel } from './payouts';

describe('payoutStatusLabel', () => {
  it('КАЖДЫЙ статус из словаря подписан по-человечески', () => {
    // Перечислять статусы руками нельзя: пятый статус в `PAYOUT_STATUSES`
    // остался бы без подписи молча, и экран показал бы идентификатор.
    for (const status of PAYOUT_STATUSES) {
      expect(payoutStatusLabel(status)).not.toBe(status);
      expect(payoutStatusLabel(status).length).toBeGreaterThan(0);
    }
  });

  it('незнакомый статус показывается как есть', () => {
    expect(payoutStatusLabel('frozen')).toBe('frozen');
  });

  it('ключ прототипа не выдаётся за подпись', () => {
    expect(payoutStatusLabel('toString')).toBe('toString');
  });
});

describe('isPayoutDecidable', () => {
  it('решать можно по ждущей заявке', () => {
    expect(isPayoutDecidable('requested')).toBe(true);
  });

  it('ЗАСТРЯВШАЯ в processing заявка решается тоже', () => {
    // «Выплачено» — два перехода вне одной транзакции: упавший между ними
    // процесс оставляет заявку здесь, её сумма продолжает вычитаться из
    // баланса, и без этого правила вынуть её можно было бы только SQL'ем.
    expect(isPayoutDecidable('processing')).toBe(true);
  });

  it('по закрытой заявке решать нечего', () => {
    expect(isPayoutDecidable('paid')).toBe(false);
    expect(isPayoutDecidable('rejected')).toBe(false);
  });
});
