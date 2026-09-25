import { describe, expect, it } from 'vitest';

import { EnvError, loadEnv } from './env.ts';

function minimal(): Record<string, string> {
  return {
    SMM_BOT_TOKEN: '123:abc',
    SMM_OWNER_ID: '379336096',
    SMM_CHANNEL_ID: '-1004257122135',
    SMM_CHANNEL_USERNAME: 'ooplatishka',
    SMM_MODEL_API_KEY: 'sk-test',
  };
}

describe('второй канал в окружении', () => {
  it('не задан — канал один, основной', () => {
    expect(loadEnv(minimal()).channels).toEqual([
      { key: 'main', id: '-1004257122135', username: 'ooplatishka', title: 'Оплатишка', label: 'В Оплатишку' },
    ]);
  });

  it('задан парой — второй канал с правилами из конфига', () => {
    const env = loadEnv({
      ...minimal(),
      SMM_SECOND_CHANNEL_ID: '-1003314281166',
      SMM_SECOND_CHANNEL_USERNAME: '@aibromotion',
    });
    expect(env.channels[1]).toEqual({
      key: 'second',
      id: '-1003314281166',
      username: 'aibromotion',
      title: 'Aibromotion',
      label: 'В Aibromotion',
    });
  });

  it('половина пары — отказ старта с именем переменной, а не полканала', () => {
    expect(() => loadEnv({ ...minimal(), SMM_SECOND_CHANNEL_ID: '-1003314281166' })).toThrowError(EnvError);
    expect(() => loadEnv({ ...minimal(), SMM_SECOND_CHANNEL_USERNAME: 'aibromotion' })).toThrowError(
      /SMM_SECOND_CHANNEL_ID/,
    );
  });

  it('второй канал, совпадающий с основным, отвергается: «в оба» опубликовало бы дважды', () => {
    expect(() =>
      loadEnv({ ...minimal(), SMM_SECOND_CHANNEL_ID: '-1004257122135', SMM_SECOND_CHANNEL_USERNAME: 'ooplatishka' }),
    ).toThrowError(/совпадает с основным/);
  });

  it('своё название второго канала попадает и в подпись кнопки', () => {
    const env = loadEnv({
      ...minimal(),
      SMM_SECOND_CHANNEL_ID: '-1003314281166',
      SMM_SECOND_CHANNEL_USERNAME: 'aibromotion',
      SMM_SECOND_CHANNEL_TITLE: 'bromotion',
    });
    expect(env.channels[1]).toMatchObject({ title: 'bromotion', label: 'В bromotion' });
  });
});
