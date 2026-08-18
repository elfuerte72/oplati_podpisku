import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  LOGIN_WIDGET_MAX_AGE_SECONDS,
  verifyLoginWidgetPayload,
} from './telegram-login';

/**
 * Первый фактор входа в панель — Telegram Login Widget.
 *
 * Подпись считает Telegram, поэтому проверять надо ИМЕННО их формулу, а не
 * нашу: секрет — SHA256 от токена бота, данные — все поля кроме `hash`,
 * отсортированные по имени и склеенные через перевод строки. Тест строит
 * payload по контракту руками — если реализация «упростит» формулу, он падёт.
 */

const BOT_TOKEN = '7992756364:AAH-test-token-for-login-widget';

function sign(fields: Record<string, string>, token = BOT_TOKEN): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHash('sha256').update(token).digest();
  return createHmac('sha256', secret).update(dataCheckString).digest('hex');
}

function payload(over: Record<string, string> = {}, token = BOT_TOKEN) {
  const fields: Record<string, string> = {
    id: '379336096',
    first_name: 'Владелец',
    username: 'owner',
    auth_date: '1755000000',
    ...over,
  };
  return { ...fields, hash: sign(fields, token) };
}

const NOW = 1755000010;

describe('verifyLoginWidgetPayload', () => {
  it('валидная подпись принимается, telegram_id приходит строкой', () => {
    const res = verifyLoginWidgetPayload(payload(), BOT_TOKEN, NOW);

    expect(res).toMatchObject({ ok: true, telegramId: '379336096', displayName: 'Владелец' });
  });

  it('подпись отдаётся наружу — по ней вызывающий делает вход одноразовым', () => {
    const p = payload();
    const res = verifyLoginWidgetPayload(p, BOT_TOKEN, NOW);

    expect(res).toMatchObject({ ok: true, signature: p.hash });
  });

  it('многобайтовый символ в подписи — отказ, а не падение', () => {
    // Своя проверка длины считала бы СИМВОЛЫ, а timingSafeEqual меряет БАЙТЫ:
    // такой ввод давал 500 на входе и проходил мимо счётчика попыток.
    const evil = { ...payload(), hash: `é${'a'.repeat(63)}` };

    expect(() => verifyLoginWidgetPayload(evil, BOT_TOKEN, NOW)).not.toThrow();
    expect(verifyLoginWidgetPayload(evil, BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('имя собирается из first_name и last_name', () => {
    const res = verifyLoginWidgetPayload(
      payload({ first_name: 'Иван', last_name: 'Петров' }),
      BOT_TOKEN,
      NOW,
    );

    expect(res).toMatchObject({ ok: true, displayName: 'Иван Петров' });
  });

  it('подделанное поле ломает подпись', () => {
    const bad = { ...payload(), id: '730162414' };

    expect(verifyLoginWidgetPayload(bad, BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('подпись чужим токеном не принимается', () => {
    const foreign = payload({}, '111:another-bot-token');

    expect(verifyLoginWidgetPayload(foreign, BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('лишнее поле в payload ломает подпись — его не игнорируем молча', () => {
    const withExtra = { ...payload(), photo_url: 'https://example.com/a.jpg' };

    expect(verifyLoginWidgetPayload(withExtra, BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('все переданные поля участвуют в подписи, а не только известные нам', () => {
    const fields = {
      id: '379336096',
      first_name: 'Владелец',
      auth_date: '1755000000',
      photo_url: 'https://t.me/i/userpic/320/owner.jpg',
    };
    const signed = { ...fields, hash: sign(fields) };

    expect(verifyLoginWidgetPayload(signed, BOT_TOKEN, NOW)).toMatchObject({ ok: true });
  });

  it('просроченный вход отвергается: окно — минуты, не часы', () => {
    const old = payload({ auth_date: String(NOW - LOGIN_WIDGET_MAX_AGE_SECONDS - 1) });

    expect(verifyLoginWidgetPayload(old, BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('вход внутри окна принимается', () => {
    const fresh = payload({ auth_date: String(NOW - LOGIN_WIDGET_MAX_AGE_SECONDS + 5) });

    expect(verifyLoginWidgetPayload(fresh, BOT_TOKEN, NOW)).toMatchObject({ ok: true });
  });

  it('auth_date из будущего отвергается — иначе окно свежести обходится', () => {
    const future = payload({ auth_date: String(NOW + 600) });

    expect(verifyLoginWidgetPayload(future, BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('битая форма payload отвергается до криптографии', () => {
    expect(verifyLoginWidgetPayload({ id: '1' }, BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyLoginWidgetPayload(null, BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyLoginWidgetPayload({ ...payload(), hash: 'нехекс' }, BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('без токена бота вход невозможен — это авария конфига, а не отказ клиента', () => {
    expect(verifyLoginWidgetPayload(payload(), '', NOW)).toEqual({
      ok: false,
      reason: 'not_configured',
    });
  });
});
