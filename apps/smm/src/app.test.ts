import { describe, expect, it } from 'vitest';

import { startApp } from './app.ts';
import { loadEnv } from './config/env.ts';
import { createLogger } from './logger.ts';
import { openStore } from './store/index.ts';

function testEnv() {
  return loadEnv({
    SMM_BOT_TOKEN: '123:abc',
    SMM_OWNER_ID: '1',
    SMM_CHANNEL_ID: '-100123',
    SMM_CHANNEL_USERNAME: 'ooplatishka',
    SMM_MODEL_API_KEY: 'sk-test',
  });
}

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'info',
    stream: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  });
  return { logger, out: () => lines.join(''), lines };
}

describe('startApp', () => {
  it('поднимается с готовым хранилищем, пишет строку старта и гасится идемпотентно', async () => {
    const { logger, lines, out } = capture();
    const store = openStore({ path: ':memory:' });

    const app = startApp({ env: testEnv(), logger, store });
    expect(out()).toContain('бот SMM поднялся');
    // Миграции применились при открытии базы, а не «когда-нибудь потом».
    expect(store.applied.length).toBeGreaterThan(0);

    await app.stop();
    await app.stop();
    expect(lines.filter((line) => line.includes('бот SMM остановлен'))).toHaveLength(1);
    // Чужую базу остановка не закрывает: тест продолжает ей пользоваться.
    expect(() => store.posts.listByStatus(['draft'])).not.toThrow();
    store.close();
  });

  it('секреты в строку старта не попадают', () => {
    const { logger, out } = capture();
    const store = openStore({ path: ':memory:' });
    startApp({ env: testEnv(), logger, store });
    expect(out()).not.toContain('123:abc');
    expect(out()).not.toContain('sk-test');
    store.close();
  });

  it('свою базу остановка закрывает', async () => {
    const { logger } = capture();
    const env = loadEnv({
      SMM_BOT_TOKEN: '123:abc',
      SMM_OWNER_ID: '1',
      SMM_CHANNEL_ID: '-100123',
      SMM_CHANNEL_USERNAME: 'ooplatishka',
      SMM_MODEL_API_KEY: 'sk-test',
      SMM_DB_PATH: ':memory:',
    });
    const app = startApp({ env, logger });
    await app.stop();
    // Закрытая база бросает на любом запросе — это и проверяем.
    expect(() => app.store.posts.listByStatus(['draft'])).toThrow();
  });
});
