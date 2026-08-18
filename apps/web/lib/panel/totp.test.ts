import { describe, expect, it } from 'vitest';

import {
  TOTP_STEP_SECONDS,
  buildOtpAuthUri,
  decodeBase32,
  encodeBase32,
  generateTotpSecret,
  totpCodeAt,
  verifyTotp,
} from './totp';

/**
 * Второй фактор входа в панель. Реализация своя (RFC 6238 на `node:crypto`), а
 * не библиотека: алгоритм — тридцать строк, а зависимость в аутентификации это
 * ещё один канал поставки, за которым надо следить.
 *
 * Поэтому проверяем не «наш код сам с собой», а официальные тест-векторы
 * RFC 6238 (приложение B, HMAC-SHA1) и RFC 4648 для base32.
 */

/** Секрет тест-векторов RFC 6238: ASCII "12345678901234567890". */
const RFC_SECRET_B32 = encodeBase32(Buffer.from('12345678901234567890', 'ascii'));

describe('base32 (RFC 4648, без набивки)', () => {
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  for (const [plain, encoded] of vectors) {
    it(`"${plain}" ↔ ${encoded || '(пусто)'}`, () => {
      expect(encodeBase32(Buffer.from(plain, 'ascii'))).toBe(encoded);
      expect(decodeBase32(encoded).toString('ascii')).toBe(plain);
    });
  }

  it('пробелы и регистр в введённом секрете не мешают', () => {
    expect(decodeBase32('mzxw 6ytb oi').toString('ascii')).toBe('foobar');
  });

  it('мусор в секрете отвергается, а не молча превращается в другой ключ', () => {
    expect(() => decodeBase32('MZXW6YTB!!')).toThrow();
  });
});

describe('totpCodeAt — тест-векторы RFC 6238 (SHA-1)', () => {
  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];

  for (const [unixSeconds, code] of vectors) {
    it(`t=${unixSeconds} → ${code}`, () => {
      expect(totpCodeAt(RFC_SECRET_B32, unixSeconds)).toBe(code);
    });
  }
});

describe('verifyTotp', () => {
  const nowSeconds = 1111111109;

  it('верный код принимается и отдаёт НОМЕР окна — им код делают одноразовым', () => {
    const res = verifyTotp(RFC_SECRET_B32, '081804', nowSeconds);

    expect(res).toEqual({ ok: true, step: Math.floor(nowSeconds / TOTP_STEP_SECONDS) });
  });

  it('неверный код отвергается', () => {
    expect(verifyTotp(RFC_SECRET_B32, '000000', nowSeconds)).toEqual({
      ok: false,
      reason: 'bad_code',
    });
  });

  it('соседнее окно принимается — часы телефона и сервера расходятся', () => {
    const prev = totpCodeAt(RFC_SECRET_B32, nowSeconds - TOTP_STEP_SECONDS);
    const next = totpCodeAt(RFC_SECRET_B32, nowSeconds + TOTP_STEP_SECONDS);

    expect(verifyTotp(RFC_SECRET_B32, prev, nowSeconds)).toMatchObject({ ok: true });
    expect(verifyTotp(RFC_SECRET_B32, next, nowSeconds)).toMatchObject({ ok: true });
  });

  it('номер окна соответствует ТОМУ коду, который совпал, а не «сейчас»', () => {
    const prev = totpCodeAt(RFC_SECRET_B32, nowSeconds - TOTP_STEP_SECONDS);

    expect(verifyTotp(RFC_SECRET_B32, prev, nowSeconds)).toEqual({
      ok: true,
      step: Math.floor((nowSeconds - TOTP_STEP_SECONDS) / TOTP_STEP_SECONDS),
    });
  });

  it('окно через одно уже не принимается — иначе код живёт слишком долго', () => {
    const old = totpCodeAt(RFC_SECRET_B32, nowSeconds - TOTP_STEP_SECONDS * 2);

    expect(verifyTotp(RFC_SECRET_B32, old, nowSeconds)).toEqual({
      ok: false,
      reason: 'bad_code',
    });
  });

  it('пробелы в введённом коде не мешают — их вставляют приложения', () => {
    expect(verifyTotp(RFC_SECRET_B32, '081 804', nowSeconds)).toMatchObject({ ok: true });
  });

  it('не-шестизначный ввод отвергается без проверки', () => {
    for (const junk of ['8180', 'abcdef', '']) {
      expect(verifyTotp(RFC_SECRET_B32, junk, nowSeconds)).toEqual({
        ok: false,
        reason: 'bad_code',
      });
    }
  });

  it('битый секрет — ОТДЕЛЬНАЯ причина: это наша авария, а не промах сотрудника', () => {
    expect(verifyTotp('!!!', '081804', nowSeconds)).toEqual({ ok: false, reason: 'bad_secret' });
    expect(verifyTotp('', '081804', nowSeconds)).toEqual({ ok: false, reason: 'bad_secret' });
  });

  it('битый секрет не бросает исключение ни при каком вводе', () => {
    expect(() => verifyTotp('###', '000000', nowSeconds)).not.toThrow();
  });
});

describe('generateTotpSecret', () => {
  it('секрет достаточной длины и в алфавите base32', () => {
    const secret = generateTotpSecret();

    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(decodeBase32(secret)).toHaveLength(20);
  });

  it('два вызова дают разные секреты', () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });
});

describe('buildOtpAuthUri', () => {
  it('otpauth-URI содержит выпускающего, аккаунт и секрет', () => {
    const uri = buildOtpAuthUri({
      secret: 'JBSWY3DPEHPK3PXP',
      account: 'Владелец',
      issuer: 'Оплатишка',
    });

    const parsed = new URL(uri);
    expect(parsed.protocol).toBe('otpauth:');
    expect(parsed.host).toBe('totp');
    expect(decodeURIComponent(parsed.pathname)).toBe('/Оплатишка:Владелец');
    expect(parsed.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(parsed.searchParams.get('issuer')).toBe('Оплатишка');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe(String(TOTP_STEP_SECONDS));
  });
});
