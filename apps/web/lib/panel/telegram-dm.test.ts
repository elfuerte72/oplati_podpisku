import { describe, expect, it } from 'vitest';

import { clientDirectMessage, normalizeUsername } from './telegram-dm.ts';

describe('ссылка на личную переписку с клиентом', () => {
  it('username есть — адрес t.me и подпись с собакой', () => {
    const dm = clientDirectMessage({ telegramId: '8069374561', telegramUsername: 'nigora_n' });
    expect(dm).toEqual({ available: true, url: 'https://t.me/nigora_n', handle: '@nigora_n' });
  });

  it('username записан с собакой — она снимается, адрес остаётся один', () => {
    const dm = clientDirectMessage({ telegramId: '1', telegramUsername: '@nigora_n' });
    expect(dm.available && dm.url).toBe('https://t.me/nigora_n');
  });

  it('без Telegram — писать нечем, и причина названа отдельно от «нет username»', () => {
    expect(clientDirectMessage({ telegramId: null, telegramUsername: 'ignored' })).toEqual({
      available: false,
      reason: 'no_telegram',
    });
    expect(clientDirectMessage({ telegramId: '   ', telegramUsername: 'ignored' })).toEqual({
      available: false,
      reason: 'no_telegram',
    });
  });

  it('Telegram есть, username нет — личка недоступна, но причина другая', () => {
    expect(clientDirectMessage({ telegramId: '42', telegramUsername: null })).toEqual({
      available: false,
      reason: 'no_username',
    });
  });

  /*
   * Главный барьер модуля: значение из базы едет в `href`. Слэш, вопрос или
   * двоеточие внутри увели бы ссылку с профиля клиента на чужой адрес прямо
   * из карточки — поэтому мусор не становится ссылкой вовсе.
   */
  it('всё, что не похоже на username Telegram, ссылкой не становится', () => {
    for (const bad of [
      'evil/path',
      'user?x=1',
      'javascript:alert(1)',
      'ab',
      'a'.repeat(33),
      'кириллица',
      'with space',
      'dash-not-allowed',
      '',
    ]) {
      expect(normalizeUsername(bad), bad).toBeNull();
      expect(clientDirectMessage({ telegramId: '1', telegramUsername: bad })).toEqual({
        available: false,
        reason: 'no_username',
      });
    }
  });

  it('четырёхбуквенные имена ранних аккаунтов принимаются', () => {
    expect(normalizeUsername('nemo')).toBe('nemo');
  });
});
