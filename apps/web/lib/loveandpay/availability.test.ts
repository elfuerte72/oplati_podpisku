import { describe, expect, it } from 'vitest';

import { isPaymentProviderUnavailable } from './availability.ts';
import { LoveAndPayApiError, LoveAndPayContractError } from './errors.ts';

describe('isPaymentProviderUnavailable (тех. сбой vs обычная ошибка)', () => {
  it('сетевой сбой fetch (упавший прокси/DNS) → true', () => {
    // undici бросает TypeError('fetch failed') — так выглядит лежащий squid.
    expect(isPaymentProviderUnavailable(new TypeError('fetch failed'))).toBe(true);
  });

  it('таймаут (AbortError) → true', () => {
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    expect(isPaymentProviderUnavailable(abort)).toBe(true);
  });

  it('L&P 5xx после ретраев → true', () => {
    const err = new LoveAndPayApiError({
      code: 'INTERNAL_ERROR',
      httpStatus: 502,
      message: 'Bad gateway',
    });
    expect(isPaymentProviderUnavailable(err)).toBe(true);
  });

  it('L&P 429 (перегрузка) → true', () => {
    const err = new LoveAndPayApiError({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      message: 'Too many requests',
    });
    expect(isPaymentProviderUnavailable(err)).toBe(true);
  });

  it('L&P 4xx (ошибка запроса, провайдер жив) → false', () => {
    const err = new LoveAndPayApiError({
      code: 'DOMAIN_NOT_VERIFIED',
      httpStatus: 403,
      message: 'Forbidden',
    });
    expect(isPaymentProviderUnavailable(err)).toBe(false);
  });

  it('контракт-дрейф (провайдер ответил, но форма неожиданная) → false', () => {
    expect(
      isPaymentProviderUnavailable(new LoveAndPayContractError(200, 'schema mismatch', '{}')),
    ).toBe(false);
  });

  it('прочие ошибки → false', () => {
    expect(isPaymentProviderUnavailable(new Error('что-то ещё'))).toBe(false);
    expect(isPaymentProviderUnavailable(new TypeError('x is not a function'))).toBe(false);
    expect(isPaymentProviderUnavailable(null)).toBe(false);
  });
});
