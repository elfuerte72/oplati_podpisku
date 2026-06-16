import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { canonicalQuery, signPaySpaceRequest } from './sign.ts';

const SECRET = 'request_secret_test';

function expectedSignature(message: string): string {
  return createHmac('sha256', SECRET).update(message).digest('base64');
}

describe('signPaySpaceRequest', () => {
  it('строит подпись по контракту METHOD\\nPATH\\nQUERY\\nBODY_SHA256\\nTS\\nNONCE', () => {
    const body = '{"amount":"10.00"}';
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const headers = signPaySpaceRequest({
      method: 'post',
      path: '/api/v1/vcc/card/create/',
      canonicalQuery: '',
      body,
      requestSecret: SECRET,
      now: () => 1_700_000_000_000, // ms
      nonce: () => 'fixed-nonce',
    });

    expect(headers['X-Timestamp']).toBe('1700000000'); // секунды
    expect(headers['X-Nonce']).toBe('fixed-nonce');

    const message = [
      'POST', // верхний регистр
      '/api/v1/vcc/card/create/',
      '',
      bodyHash,
      '1700000000',
      'fixed-nonce',
    ].join('\n');
    expect(headers['X-Signature']).toBe(expectedSignature(message));
  });

  it('пустое тело хешируется как sha256("")', () => {
    const emptyHash = createHash('sha256').update('').digest('hex');
    expect(emptyHash).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    const headers = signPaySpaceRequest({
      method: 'GET',
      path: '/api/v1/vcc/user/balance/',
      canonicalQuery: '',
      body: '',
      requestSecret: SECRET,
      now: () => 1_700_000_000_000,
      nonce: () => 'n',
    });
    const message = ['GET', '/api/v1/vcc/user/balance/', '', emptyHash, '1700000000', 'n'].join(
      '\n',
    );
    expect(headers['X-Signature']).toBe(expectedSignature(message));
  });
});

describe('canonicalQuery', () => {
  it('сортирует по ключу и склеивает k=v через &', () => {
    expect(canonicalQuery({ request_id: 'r1', card_id: 'c1' })).toBe(
      'card_id=c1&request_id=r1',
    );
  });

  it('пропускает undefined и отдаёт пусто без параметров', () => {
    expect(canonicalQuery({ a: undefined })).toBe('');
    expect(canonicalQuery({})).toBe('');
  });
});
