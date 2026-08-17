import { describe, expect, it } from 'vitest';

import {
  PANEL_PENDING_TTL_SECONDS,
  PANEL_SESSION_TTL_SECONDS,
  signPanelToken,
  verifyPanelToken,
} from './token';

/**
 * Сессия панели — подписанная cookie, без таблицы сессий.
 *
 * Отзыв доступа держится не на сроке cookie, а на `is_active`, который
 * проверяется на КАЖДОМ запросе (спека §4.1). Поэтому от токена требуется
 * ровно две вещи: его нельзя подделать и он протухает сам.
 */

const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);
const STAFF_ID = '00000000-0000-4000-8000-000000000001';
const NOW = 1_755_000_000;

describe('signPanelToken / verifyPanelToken', () => {
  it('свой токен принимается и отдаёт сотрудника', () => {
    const token = signPanelToken({ purpose: 'session', staffId: STAFF_ID }, SECRET, NOW);

    expect(verifyPanelToken(token, SECRET, { purpose: 'session', nowSeconds: NOW + 60 })).toEqual({
      ok: true,
      staffId: STAFF_ID,
      issuedAt: NOW,
    });
  });

  it('правка тела ломает подпись', () => {
    const token = signPanelToken({ purpose: 'session', staffId: STAFF_ID }, SECRET, NOW);
    const [version, body, signature] = token.split('.');
    const evil = Buffer.from(
      JSON.stringify({ p: 'session', s: 'подменённый', i: NOW }),
      'utf8',
    ).toString('base64url');

    expect(
      verifyPanelToken(`${version}.${evil}.${signature}`, SECRET, {
        purpose: 'session',
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
    expect(body).not.toBe(evil);
  });

  it('чужой секрет не подходит', () => {
    const token = signPanelToken({ purpose: 'session', staffId: STAFF_ID }, OTHER_SECRET, NOW);

    expect(verifyPanelToken(token, SECRET, { purpose: 'session', nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('сессия живёт 12 часов и не дольше', () => {
    const token = signPanelToken({ purpose: 'session', staffId: STAFF_ID }, SECRET, NOW);

    expect(
      verifyPanelToken(token, SECRET, {
        purpose: 'session',
        nowSeconds: NOW + PANEL_SESSION_TTL_SECONDS - 1,
      }),
    ).toMatchObject({ ok: true });
    expect(
      verifyPanelToken(token, SECRET, {
        purpose: 'session',
        nowSeconds: NOW + PANEL_SESSION_TTL_SECONDS + 1,
      }),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('промежуточный токен между факторами живёт минуты', () => {
    const token = signPanelToken({ purpose: 'pending', staffId: STAFF_ID }, SECRET, NOW);

    expect(
      verifyPanelToken(token, SECRET, {
        purpose: 'pending',
        nowSeconds: NOW + PANEL_PENDING_TTL_SECONDS + 1,
      }),
    ).toEqual({ ok: false, reason: 'expired' });
    expect(PANEL_PENDING_TTL_SECONDS).toBeLessThan(PANEL_SESSION_TTL_SECONDS);
  });

  it('токен «прошёл первый фактор» НЕ работает как сессия — иначе TOTP обходится', () => {
    const pending = signPanelToken({ purpose: 'pending', staffId: STAFF_ID }, SECRET, NOW);

    expect(verifyPanelToken(pending, SECRET, { purpose: 'session', nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'wrong_purpose',
    });
  });

  it('полная сессия не сходит за промежуточный токен', () => {
    const session = signPanelToken({ purpose: 'session', staffId: STAFF_ID }, SECRET, NOW);

    expect(verifyPanelToken(session, SECRET, { purpose: 'pending', nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'wrong_purpose',
    });
  });

  it('токен из будущего отвергается — часы не должны продлевать сессию', () => {
    const token = signPanelToken({ purpose: 'session', staffId: STAFF_ID }, SECRET, NOW + 3600);

    expect(verifyPanelToken(token, SECRET, { purpose: 'session', nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('мусор вместо токена — отказ, а не исключение', () => {
    for (const junk of [
      '',
      'нетточек',
      'v1.только.два.лишних.куска',
      'v9.aaa.bbb',
      'v1..',
      // Многобайтовый символ в подписи: проверка длины в СИМВОЛАХ + побайтовый
      // timingSafeEqual роняли RangeError, и падала сама страница входа —
      // с которой эту cookie уже не сбросить.
      'v1.aaa.é',
      `v1.aaa.${'é'.repeat(43)}`,
    ]) {
      expect(
        verifyPanelToken(junk, SECRET, { purpose: 'session', nowSeconds: NOW }),
      ).toMatchObject({ ok: false });
    }
  });

  it('без секрета токен не подписывается — это авария конфига', () => {
    expect(() => signPanelToken({ purpose: 'session', staffId: STAFF_ID }, '', NOW)).toThrow();
    expect(verifyPanelToken('v1.aaa.bbb', '', { purpose: 'session', nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'not_configured',
    });
  });
});
