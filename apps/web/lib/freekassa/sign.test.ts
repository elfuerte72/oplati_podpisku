import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  buildSignaturePayload,
  expectedNotificationSignature,
  signApiRequest,
  verifyNotificationSignature,
} from './sign.ts';

const API_KEY = 'test-api-key';
const SECRET_2 = 'secret-word-2';

describe('подпись запроса к API (HMAC-SHA256)', () => {
  const params = {
    shopId: 777,
    nonce: 2_000_000_001,
    paymentId: 'ORD-S3MGS-a1b2c3',
    i: 44,
    email: '12345@telegram.org',
    ip: '177.7.34.106',
    amount: 2490.5,
    currency: 'RUB',
  };

  it('склеивает значения в алфавитном порядке КЛЮЧЕЙ через |', () => {
    // Порядок ключей: amount, currency, email, i, ip, nonce, paymentId, shopId.
    expect(buildSignaturePayload(params)).toBe(
      '2490.5|RUB|12345@telegram.org|44|177.7.34.106|2000000001|ORD-S3MGS-a1b2c3|777',
    );
  });

  it('не зависит от порядка ключей в объекте', () => {
    const shuffled = {
      currency: params.currency,
      shopId: params.shopId,
      amount: params.amount,
      ip: params.ip,
      nonce: params.nonce,
      email: params.email,
      paymentId: params.paymentId,
      i: params.i,
    };
    expect(buildSignaturePayload(shuffled)).toBe(buildSignaturePayload(params));
  });

  it('совпадает с PHP-эталоном ksort + implode + hash_hmac', () => {
    const expected = createHmac('sha256', API_KEY)
      .update('2490.5|RUB|12345@telegram.org|44|177.7.34.106|2000000001|ORD-S3MGS-a1b2c3|777')
      .digest('hex');
    expect(signApiRequest(params, API_KEY)).toBe(expected);
  });

  it('числовые значения попадают в подпись ровно так, как их сериализует JSON', () => {
    // Иначе подписанная строка разойдётся с телом запроса и провайдер отвергнет
    // каждый вызов; отдельного форматирования сумм быть не должно.
    const payload = buildSignaturePayload({ amount: 2490.5, shopId: 777 });
    expect(payload.split('|')[0]).toBe(JSON.stringify(2490.5));
  });

  it('меняется при смене любого параметра', () => {
    const base = signApiRequest(params, API_KEY);
    expect(signApiRequest({ ...params, nonce: params.nonce + 1 }, API_KEY)).not.toBe(base);
    expect(signApiRequest({ ...params, amount: 2490.51 }, API_KEY)).not.toBe(base);
    expect(signApiRequest(params, 'другой-ключ')).not.toBe(base);
  });
});

describe('подпись уведомления (MD5)', () => {
  const notification = {
    MERCHANT_ID: '777',
    AMOUNT: '2490.50',
    MERCHANT_ORDER_ID: 'ORD-S3MGS-a1b2c3',
  };

  const validSign = createHash('md5')
    .update('777:2490.50:secret-word-2:ORD-S3MGS-a1b2c3')
    .digest('hex');

  it('считается по формуле MERCHANT_ID:AMOUNT:секрет2:MERCHANT_ORDER_ID', () => {
    expect(expectedNotificationSignature(notification, SECRET_2)).toBe(validSign);
  });

  it('принимает валидную подпись в любом регистре', () => {
    expect(verifyNotificationSignature({ ...notification, SIGN: validSign }, SECRET_2)).toBe(true);
    expect(
      verifyNotificationSignature({ ...notification, SIGN: validSign.toUpperCase() }, SECRET_2),
    ).toBe(true);
  });

  it('отвергает подделку, чужой секрет и подпись другой длины', () => {
    expect(verifyNotificationSignature({ ...notification, SIGN: 'deadbeef' }, SECRET_2)).toBe(false);
    expect(verifyNotificationSignature({ ...notification, SIGN: validSign }, 'чужой')).toBe(false);
    expect(verifyNotificationSignature({ ...notification, SIGN: '' }, SECRET_2)).toBe(false);
  });

  it('подпись считается по СЫРОЙ строке AMOUNT, а не по нормализованной', () => {
    // `2490.50` и `2490.5` — одна сумма, но разные MD5. Нормализуй мы AMOUNT
    // перед проверкой, валидные уведомления отвергались бы.
    const normalized = verifyNotificationSignature(
      { ...notification, AMOUNT: '2490.5', SIGN: validSign },
      SECRET_2,
    );
    expect(normalized).toBe(false);
  });

  it('подмена суммы или номера заказа ломает подпись', () => {
    expect(
      verifyNotificationSignature({ ...notification, AMOUNT: '1.00', SIGN: validSign }, SECRET_2),
    ).toBe(false);
    expect(
      verifyNotificationSignature(
        { ...notification, MERCHANT_ORDER_ID: 'ORD-OTHER', SIGN: validSign },
        SECRET_2,
      ),
    ).toBe(false);
  });
});
