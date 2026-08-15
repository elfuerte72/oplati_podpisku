import { describe, expect, it } from 'vitest';

import { phoneTailMatches } from './phone-match.ts';

describe('phoneTailMatches (сверка с payer_account, тикет 07)', () => {
  it('хвост маски совпал с хвостом номера → true', () => {
    expect(phoneTailMatches('****4567', '+79991234567')).toBe(true);
  });

  it('не совпал → false (пометка, НЕ блокировка — Р4)', () => {
    expect(phoneTailMatches('****0000', '+79991234567')).toBe(false);
  });

  it('нет данных → null: без маски, без номера, слишком короткая маска', () => {
    expect(phoneTailMatches(undefined, '+79991234567')).toBeNull();
    expect(phoneTailMatches('****4567', null)).toBeNull();
    // Маска без цифр (короткий payer_account → '****').
    expect(phoneTailMatches('****', '+79991234567')).toBeNull();
    expect(phoneTailMatches('***7', '+79991234567')).toBeNull();
  });
});
