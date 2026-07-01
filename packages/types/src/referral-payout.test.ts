import { describe, expect, it } from 'vitest';

import {
  REFERRAL_PAYOUT_FEE_BPS,
  computePayoutFee,
  isValidLuhn,
  maskPan,
  payoutDestinationInputSchema,
  toStoredPayoutDestination,
  canTransitionPayout,
  isTerminalPayoutStatus,
  PAYOUT_ALLOWED_TRANSITIONS,
  type PayoutStatus,
} from './referral-payout.ts';

describe('computePayoutFee', () => {
  it('карта РФ — 3.5%, округление вниз', () => {
    expect(REFERRAL_PAYOUT_FEE_BPS.card_rub).toBe(350);
    expect(computePayoutFee('card_rub', 2000)).toEqual({ feeBps: 350, feeUsdCents: 70, netUsdCents: 1930 });
    // 999 * 350 / 10000 = 34.965 → floor 34
    expect(computePayoutFee('card_rub', 999)).toEqual({ feeBps: 350, feeUsdCents: 34, netUsdCents: 965 });
  });

  it('крипта USDT — 1%', () => {
    expect(REFERRAL_PAYOUT_FEE_BPS.crypto_usdt).toBe(100);
    expect(computePayoutFee('crypto_usdt', 2000)).toEqual({ feeBps: 100, feeUsdCents: 20, netUsdCents: 1980 });
  });

  it('нулевая/отрицательная сумма → комиссия 0', () => {
    expect(computePayoutFee('card_rub', 0)).toEqual({ feeBps: 350, feeUsdCents: 0, netUsdCents: 0 });
    expect(computePayoutFee('crypto_usdt', -100)).toEqual({ feeBps: 100, feeUsdCents: 0, netUsdCents: -100 });
  });

  it('net + fee = gross (инвариант удержания)', () => {
    for (const gross of [1000, 1234, 5555, 99999]) {
      const c = computePayoutFee('card_rub', gross);
      expect(c.feeUsdCents + c.netUsdCents).toBe(gross);
    }
  });
});

describe('isValidLuhn', () => {
  it('валидные тестовые карты проходят', () => {
    expect(isValidLuhn('4242424242424242')).toBe(true); // Visa test
    expect(isValidLuhn('4242 4242 4242 4242')).toBe(true); // с пробелами
    expect(isValidLuhn('5555555555554444')).toBe(true); // Mastercard test
  });

  it('опечатка/мусор не проходит', () => {
    expect(isValidLuhn('4242424242424241')).toBe(false); // сбитая контрольная цифра
    expect(isValidLuhn('1234')).toBe(false); // слишком короткий
    expect(isValidLuhn('abcd')).toBe(false);
    expect(isValidLuhn('')).toBe(false);
  });

  it('слишком длинный (>19) не проходит', () => {
    expect(isValidLuhn('4'.repeat(20))).toBe(false);
  });
});

describe('maskPan', () => {
  it('маскирует до ****last4', () => {
    expect(maskPan('4242424242424242')).toEqual({ panMasked: '****4242', last4: '4242' });
    expect(maskPan('4000 0000 0000 0002')).toEqual({ panMasked: '****0002', last4: '0002' });
  });
});

describe('payoutDestinationInputSchema', () => {
  it('карта: валидный PAN проходит, ФИО обязательно', () => {
    const parsed = payoutDestinationInputSchema.safeParse({
      method: 'card_rub',
      pan: '4242424242424242',
      holderName: 'IVAN IVANOV',
    });
    expect(parsed.success).toBe(true);
  });

  it('карта: невалидный PAN отклоняется', () => {
    const parsed = payoutDestinationInputSchema.safeParse({
      method: 'card_rub',
      pan: '1111111111111111',
      holderName: 'IVAN IVANOV',
    });
    expect(parsed.success).toBe(false);
  });

  it('CVV в теле игнорируется (не часть контракта)', () => {
    const parsed = payoutDestinationInputSchema.safeParse({
      method: 'card_rub',
      pan: '4242424242424242',
      holderName: 'IVAN IVANOV',
      cvv: '123',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('cvv');
    }
  });

  it('крипта: адрес + известная сеть', () => {
    const parsed = payoutDestinationInputSchema.safeParse({
      method: 'crypto_usdt',
      address: 'TQ5Rk8m9WcNvY2p3aBcDeFgHiJkLmNoPqR',
      network: 'trc20',
    });
    expect(parsed.success).toBe(true);
  });

  it('крипта: неизвестная сеть отклоняется', () => {
    const parsed = payoutDestinationInputSchema.safeParse({
      method: 'crypto_usdt',
      address: 'TQ5Rk8m9WcNvY2p3aBcDeFgHiJkLmNoPqR',
      network: 'solana',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('toStoredPayoutDestination', () => {
  it('карта: PAN превращается в маску — полного номера в результате нет', () => {
    const stored = toStoredPayoutDestination({
      method: 'card_rub',
      pan: '4242424242424242',
      holderName: 'IVAN IVANOV',
    });
    expect(stored).toEqual({
      method: 'card_rub',
      panMasked: '****4242',
      last4: '4242',
      holderName: 'IVAN IVANOV',
    });
    expect(JSON.stringify(stored)).not.toContain('4242424242424242');
  });

  it('крипта: адрес и сеть проходят как есть', () => {
    const stored = toStoredPayoutDestination({
      method: 'crypto_usdt',
      address: 'TQ5Rk8m9WcNvY2p3aBcDeFgHiJkLmNoPqR',
      network: 'trc20',
    });
    expect(stored).toEqual({
      method: 'crypto_usdt',
      address: 'TQ5Rk8m9WcNvY2p3aBcDeFgHiJkLmNoPqR',
      network: 'trc20',
    });
  });
});

describe('машина статусов заявки', () => {
  it('разрешённые переходы', () => {
    expect(canTransitionPayout('requested', 'processing')).toBe(true);
    expect(canTransitionPayout('requested', 'rejected')).toBe(true);
    expect(canTransitionPayout('processing', 'paid')).toBe(true);
    expect(canTransitionPayout('processing', 'rejected')).toBe(true);
  });

  it('запрещённые переходы', () => {
    expect(canTransitionPayout('requested', 'paid')).toBe(false); // нельзя минуя processing
    expect(canTransitionPayout('paid', 'processing')).toBe(false); // терминал
    expect(canTransitionPayout('rejected', 'requested')).toBe(false);
    expect(canTransitionPayout('processing', 'requested')).toBe(false); // без понижений
  });

  it('терминальные статусы', () => {
    expect(isTerminalPayoutStatus('paid')).toBe(true);
    expect(isTerminalPayoutStatus('rejected')).toBe(true);
    expect(isTerminalPayoutStatus('requested')).toBe(false);
    expect(isTerminalPayoutStatus('processing')).toBe(false);
  });

  it('нет самоперехода в графе', () => {
    for (const [from, targets] of Object.entries(PAYOUT_ALLOWED_TRANSITIONS)) {
      expect(targets).not.toContain(from as PayoutStatus);
    }
  });
});
