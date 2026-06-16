import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { validateInitData, telegramUserDisplayName } from './init-data.ts';

/**
 * Тесты валидации Telegram Mini App initData.
 *
 * Фикстуры подписываются ТЕМ ЖЕ алгоритмом, что и в проверке (self-consistent):
 * это покрывает разбор query-string, сортировку data_check_string, сравнение
 * подписи и проверку свежести. Соответствие РЕАЛЬНОМУ формату Telegram
 * подтверждается отдельно — smoke-тестом dev-бота (см. шапку init-data.ts);
 * как появится живой initData, его стоит зафиксировать здесь отдельным кейсом.
 */

const BOT_TOKEN = '7000000000:TEST_TOKEN_dummy_value';

/** Собирает подписанный initData из набора полей (повторяет контракт Telegram). */
function signInitData(
  fields: Record<string, string>,
  token = BOT_TOKEN,
): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, v);
  params.set('hash', hash);
  return params.toString();
}

const USER = {
  id: 123456789,
  first_name: 'Иван',
  last_name: 'Петров',
  username: 'ivan',
  language_code: 'ru',
};

function freshFields(nowMs: number, user: unknown = USER): Record<string, string> {
  return {
    user: JSON.stringify(user),
    auth_date: String(Math.floor(nowMs / 1000)),
    query_id: 'AAabc123',
  };
}

describe('validateInitData', () => {
  const now = 1_750_000_000_000; // фиксированное «сейчас» для детерминизма

  it('валидный initData → ok + распарсенный user', () => {
    const initData = signInitData(freshFields(now));
    const res = validateInitData(initData, BOT_TOKEN, { nowMs: now });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.user.id).toBe(USER.id);
      expect(res.user.first_name).toBe('Иван');
      expect(res.authDate.getTime()).toBe(Math.floor(now / 1000) * 1000);
    }
  });

  it('подделанный hash → bad_signature', () => {
    const initData = signInitData(freshFields(now));
    const tampered = initData.replace(/hash=[a-f0-9]+/, 'hash=' + 'd'.repeat(64));
    const res = validateInitData(tampered, BOT_TOKEN, { nowMs: now });
    expect(res).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('подмена данных при сохранённой подписи → bad_signature', () => {
    const initData = signInitData(freshFields(now));
    // меняем user на чужой id, hash остаётся прежним
    const evil = initData.replace(
      encodeURIComponent(JSON.stringify(USER)),
      encodeURIComponent(JSON.stringify({ ...USER, id: 999 })),
    );
    const res = validateInitData(evil, BOT_TOKEN, { nowMs: now });
    expect(res.ok).toBe(false);
  });

  it('подпись чужим токеном → bad_signature', () => {
    const initData = signInitData(freshFields(now), '7000000000:OTHER_TOKEN');
    const res = validateInitData(initData, BOT_TOKEN, { nowMs: now });
    expect(res).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('протухший auth_date → expired', () => {
    const old = now - 25 * 60 * 60 * 1000; // 25 часов назад
    const initData = signInitData(freshFields(old));
    const res = validateInitData(initData, BOT_TOKEN, { nowMs: now });
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });

  it('свежесть в пределах окна → ok', () => {
    const recent = now - 23 * 60 * 60 * 1000; // 23 часа назад
    const initData = signInitData(freshFields(recent));
    const res = validateInitData(initData, BOT_TOKEN, { nowMs: now });
    expect(res.ok).toBe(true);
  });

  it('отсутствует hash → missing_hash', () => {
    const params = new URLSearchParams(freshFields(now));
    const res = validateInitData(params.toString(), BOT_TOKEN, { nowMs: now });
    expect(res).toEqual({ ok: false, reason: 'missing_hash' });
  });

  it('нет поля user → missing_user', () => {
    const fields = { auth_date: String(Math.floor(now / 1000)), query_id: 'x' };
    const initData = signInitData(fields);
    const res = validateInitData(initData, BOT_TOKEN, { nowMs: now });
    expect(res).toEqual({ ok: false, reason: 'missing_user' });
  });

  it('битый JSON в user → malformed', () => {
    const fields = { user: '{not json', auth_date: String(Math.floor(now / 1000)) };
    const initData = signInitData(fields);
    const res = validateInitData(initData, BOT_TOKEN, { nowMs: now });
    expect(res).toEqual({ ok: false, reason: 'malformed' });
  });

  it('user без обязательного first_name → malformed', () => {
    const initData = signInitData(freshFields(now, { id: 1 }));
    const res = validateInitData(initData, BOT_TOKEN, { nowMs: now });
    expect(res).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('telegramUserDisplayName', () => {
  it('склеивает имя и фамилию', () => {
    expect(telegramUserDisplayName({ id: 1, first_name: 'Иван', last_name: 'Петров' })).toBe(
      'Иван Петров',
    );
  });

  it('только имя', () => {
    expect(telegramUserDisplayName({ id: 1, first_name: 'Иван' })).toBe('Иван');
  });
});
