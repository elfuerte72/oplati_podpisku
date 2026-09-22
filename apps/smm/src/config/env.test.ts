import { describe, expect, it } from 'vitest';

import { EnvError, loadEnv } from './env.ts';

/** Минимально достаточный набор: всё остальное имеет дефолт или необязательно. */
function minimal(): Record<string, string> {
  return {
    SMM_BOT_TOKEN: '123:abc',
    SMM_OWNER_ID: '379336096',
    SMM_CHANNEL_ID: '-1004257122135',
    SMM_CHANNEL_USERNAME: 'ooplatishka',
    SMM_MODEL_API_KEY: 'sk-test',
  };
}

describe('loadEnv', () => {
  it('падает с именем недостающей переменной', () => {
    const source = minimal();
    delete source.SMM_BOT_TOKEN;
    expect(() => loadEnv(source)).toThrowError(EnvError);
    expect(() => loadEnv(source)).toThrowError(/SMM_BOT_TOKEN/);
  });

  it('перечисляет все недостающие переменные разом, а не первую', () => {
    // Иначе старт контейнера без env превращается в пять перезапусков подряд.
    let message = '';
    try {
      loadEnv({});
    } catch (e) {
      message = e instanceof Error ? e.message : '';
    }
    expect(message).toContain('SMM_BOT_TOKEN');
    expect(message).toContain('SMM_OWNER_ID');
    expect(message).toContain('SMM_CHANNEL_ID');
    expect(message).toContain('SMM_MODEL_API_KEY');
  });

  it('пустая строка считается незаданной переменной', () => {
    // Dokploy и docker передают незаполненное поле как пустую строку.
    expect(() => loadEnv({ ...minimal(), SMM_BOT_TOKEN: '' })).toThrowError(/SMM_BOT_TOKEN/);
  });

  it('не пишет значение секрета в текст ошибки', () => {
    // Текст падения уходит в docker logs и в Loki: токен там жить не должен.
    let message = '';
    try {
      loadEnv({ ...minimal(), SMM_OWNER_ID: 'не-число' });
    } catch (e) {
      message = e instanceof Error ? e.message : '';
    }
    expect(message).toContain('SMM_OWNER_ID');
    expect(message).not.toContain('123:abc');
    expect(message).not.toContain('sk-test');
  });

  it('даёт дефолты модели, окна отмены и пути к базе', () => {
    const env = loadEnv(minimal());
    expect(env.model.baseUrl).toBe('https://api.deepseek.com/anthropic');
    expect(env.model.writer).toBe('deepseek-flash');
    expect(env.model.judge).toBe('deepseek-flash');
    expect(env.model.rank).toBe('deepseek-flash');
    expect(env.publishUndoSeconds).toBe(60);
    expect(env.dbPath).toBe('data/smm.db');
    expect(env.logLevel).toBe('info');
  });

  it('разбирает числа и снимает @ у имени канала', () => {
    const env = loadEnv({
      ...minimal(),
      SMM_CHANNEL_USERNAME: '@ooplatishka',
      SMM_GROUP_ID: '-1004397210384',
      SMM_GROUP_THREAD_DRAFTS: '3',
      SMM_GROUP_THREAD_REPORTS: '5',
      SMM_PUBLISH_UNDO_SECONDS: '90',
    });
    expect(env.ownerId).toBe(379336096);
    expect(env.channelUsername).toBe('ooplatishka');
    expect(env.groupThreadDrafts).toBe(3);
    expect(env.groupThreadReports).toBe(5);
    expect(env.publishUndoSeconds).toBe(90);
  });

  it('окно отмены короче пяти секунд отвергается', () => {
    // Ноль означал бы публикацию в тот же миг: кнопка «Отменить» перестала бы
    // существовать, а решение владельца «минута на передумать» — сломаться молча.
    expect(() => loadEnv({ ...minimal(), SMM_PUBLISH_UNDO_SECONDS: '0' })).toThrowError(
      /SMM_PUBLISH_UNDO_SECONDS/,
    );
  });

  it('нуль в id владельца и в id темы отвергается', () => {
    // SMM_OWNER_ID=0 — бот, который стартует зелёным и не слушается никого.
    expect(() => loadEnv({ ...minimal(), SMM_OWNER_ID: '0' })).toThrowError(/SMM_OWNER_ID/);
    expect(() =>
      loadEnv({ ...minimal(), SMM_GROUP_ID: '-100123', SMM_GROUP_THREAD_DRAFTS: '0' }),
    ).toThrowError(/SMM_GROUP_THREAD_DRAFTS/);
  });

  it('необязательные интеграции остаются пустыми без падения', () => {
    const env = loadEnv(minimal());
    expect(env.tavilyApiKey).toBeUndefined();
    expect(env.scrapeCreatorsApiKey).toBeUndefined();
    expect(env.ops.botToken).toBeUndefined();
    expect(env.ops.chatId).toBeUndefined();
    expect(env.sentryDsn).toBeUndefined();
    expect(env.groupId).toBeUndefined();
  });

  it('id канала обязан быть id или @именем, а не адресом', () => {
    expect(() => loadEnv({ ...minimal(), SMM_CHANNEL_ID: 'https://t.me/ooplatishka' })).toThrowError(
      /SMM_CHANNEL_ID/,
    );
  });
});
