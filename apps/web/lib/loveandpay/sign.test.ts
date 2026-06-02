import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

import { signRequest, verifyWebhookSignature } from './sign.ts';

describe('signRequest', () => {
  it('детерминирован при фиксированном now', () => {
    const fixedNow = () => 1_700_000_000_000;
    const a = signRequest('POST', '/invoices', '{"a":1}', 'sk_test_xyz', fixedNow);
    const b = signRequest('POST', '/invoices', '{"a":1}', 'sk_test_xyz', fixedNow);
    expect(a).toEqual(b);
    expect(a.timestamp).toBe('1700000000000');
  });

  it('подпись меняется при изменении body', () => {
    const fixedNow = () => 1_700_000_000_000;
    const a = signRequest('POST', '/invoices', '{"a":1}', 'sk', fixedNow);
    const b = signRequest('POST', '/invoices', '{"a":2}', 'sk', fixedNow);
    expect(a.signature).not.toBe(b.signature);
  });

  it('подпись меняется при изменении пути', () => {
    const fixedNow = () => 1_700_000_000_000;
    const a = signRequest('POST', '/invoices', '{}', 'sk', fixedNow);
    const b = signRequest('POST', '/rates', '{}', 'sk', fixedNow);
    expect(a.signature).not.toBe(b.signature);
  });

  it('signature — корректный HMAC-SHA256 hex', () => {
    const { signature } = signRequest('GET', '/x', '', 'sk', () => 1000);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_test';
  const body = '{"event":"invoice.paid","data":{"id":"INV-1"}}';
  const sig = createHmac('sha256', secret).update(body).digest('hex');

  it('возвращает true для валидной подписи', () => {
    expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
  });

  it('возвращает false для другой подписи', () => {
    expect(verifyWebhookSignature(body, 'a'.repeat(64), secret)).toBe(false);
  });

  it('возвращает false для подписи с другой длиной', () => {
    expect(verifyWebhookSignature(body, 'short', secret)).toBe(false);
  });

  it('возвращает false если подпись null/undefined', () => {
    expect(verifyWebhookSignature(body, null, secret)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it('возвращает false если изменено тело', () => {
    expect(verifyWebhookSignature(body + '!', sig, secret)).toBe(false);
  });
});
