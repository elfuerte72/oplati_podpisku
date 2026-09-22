import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { loadEnv } from './config/env.ts';
import { createLogger, REDACTED, scrubSecrets } from './logger.ts';

/** Логгер в память: канарейки проверяют СТРОКУ, которая уйдёт в stdout и Loki. */
function capture(level: 'info' | 'debug' = 'info') {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    stream: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  });
  return { logger, lines, out: () => lines.join(''), json: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('createLogger', () => {
  it('пишет JSON-строку с уровнем и сообщением', () => {
    const { logger, json } = capture();
    logger.info({ postId: 'p1' }, 'конвейер стартовал');
    const [record] = json();
    expect(record?.msg).toBe('конвейер стартовал');
    expect(record?.postId).toBe('p1');
    expect(record?.level).toBe('info');
  });

  it('ключ в payload редактируется до [Redacted]', () => {
    // Канарейка тикета 12: один logger.info с телом ответа провайдера уносил бы
    // ключ во внешний сбор логов, откуда его не отозвать.
    const { logger, out } = capture();
    logger.error({ request: { apiKey: 'sk-secret-value', url: 'https://api.deepseek.com' } }, 'отказ');
    expect(out()).not.toContain('sk-secret-value');
    expect(out()).toContain(REDACTED);
    // Несекретные поля рядом остаются читаемыми, иначе лог бесполезен.
    expect(out()).toContain('api.deepseek.com');
  });

  it('секрет на третьем и четвёртом уровне вложенности тоже редактируется', () => {
    // Ровно этот промах был у путей `*.token` из pino: `env.model.apiKey`
    // писался открытым текстом, пока `env.botToken` выглядел скрытым.
    const { logger, out } = capture();
    logger.error(
      {
        err: { request: { headers: { authorization: 'Bearer sk-deep' } } },
        env: { model: { apiKey: 'MODELKEY-456' }, ops: { botToken: 'OPSTOKEN-789' } },
      },
      'отказ провайдера',
    );
    const line = out();
    expect(line).not.toContain('sk-deep');
    expect(line).not.toContain('MODELKEY-456');
    expect(line).not.toContain('OPSTOKEN-789');
  });

  it('весь разобранный env не утекает ни одним секретом', () => {
    // Самый естественный вызов при диагностике старта — залогировать env целиком.
    //
    // ⚠️ Проверка идёт через `scrubSecrets`, а не через запись в лог: любой
    // объект с полями вроде `botToken`, отданный логгеру, анализатор считает
    // утечкой (CodeQL на PR #235) — и он прав, потому что отличить «канарейка»
    // от «забыли» со стороны нельзя. Гарантия от этого не слабеет: `scrubSecrets`
    // и есть то, что логгер ставит форматтером, и это закреплено канарейкой
    // ниже.
    const secrets = {
      botToken: 'BOTTOKEN-123',
      modelApiKey: 'MODELKEY-456',
      opsBotToken: 'OPSTOKEN-789',
      tavilyApiKey: 'TAVILY-000',
      scrapeCreatorsApiKey: 'SCRAPE-111',
    };
    const env = loadEnv({
      SMM_BOT_TOKEN: secrets.botToken,
      SMM_OWNER_ID: '1',
      SMM_CHANNEL_ID: '-100123',
      SMM_CHANNEL_USERNAME: 'ooplatishka',
      SMM_MODEL_API_KEY: secrets.modelApiKey,
      OPS_BOT_TOKEN: secrets.opsBotToken,
      OPS_GROUP_CHAT_ID: '-100999',
      TAVILY_API_KEY: secrets.tavilyApiKey,
      SCRAPECREATORS_API_KEY: secrets.scrapeCreatorsApiKey,
    });

    const cleaned = JSON.stringify(scrubSecrets({ env }));
    for (const secret of Object.values(secrets)) {
      expect(cleaned).not.toContain(secret);
    }
    // Поля на месте — чистка редактирует значения, а не выбрасывает структуру.
    expect(cleaned).toContain('ooplatishka');
    expect(cleaned).toContain(REDACTED);
  });

  it('логгер ставит ту самую чистку форматтером: иначе проверка выше ничего не значит', () => {
    // Канарейка по ИСХОДНИКУ: сам вызов `logger.info({ botToken })` в тесте
    // анализатор считает утечкой, а без этой связки проверка `scrubSecrets`
    // осталась бы проверкой функции, которую никто не зовёт.
    const source = readFileSync(new URL('./logger.ts', import.meta.url), 'utf8');
    expect(source).toContain('log: (record) => scrubSecrets(record)');
  });

  it('тело поста в лог не уходит', () => {
    // Пост — не секрет, но в логах он лишний: строки Loki читают посторонние,
    // а текст поста до публикации видит только владелец.
    const { logger, out } = capture();
    logger.info({ post: { body: '# Заголовок\n\nтело поста' } }, 'черновик готов');
    expect(out()).not.toContain('тело поста');
  });

  it('уровень ниже настроенного не пишется вовсе', () => {
    const { logger, lines } = capture('info');
    logger.debug({ a: 1 }, 'подробность');
    expect(lines).toHaveLength(0);
  });

  it('дочерний логгер наследует редакцию', () => {
    const { logger, out } = capture();
    logger.child({ job: 'ticker' }).info({ provider: { nested: { apiKey: 'sk-child' } } }, 'прогон');
    expect(out()).toContain('"job":"ticker"');
    expect(out()).not.toContain('sk-child');
  });

  it('ошибка логируется с типом и сообщением, но без заголовков авторизации', () => {
    const { logger, out } = capture();
    const error = Object.assign(new Error('502 от провайдера'), {
      request: { headers: { authorization: 'Bearer sk-err' } },
    });
    logger.error({ err: error }, 'вызов модели не прошёл');
    const line = out();
    expect(line).toContain('502 от провайдера');
    expect(line).not.toContain('sk-err');
  });
});

describe('scrubSecrets', () => {
  it('циклическая ссылка не вешает процесс', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node.self = node;
    expect(() => scrubSecrets(node)).not.toThrow();
    expect(JSON.stringify(scrubSecrets(node))).toContain('[Circular]');
  });

  it('массивы обходятся поэлементно', () => {
    const cleaned = scrubSecrets({ calls: [{ token: 't1' }, { token: 't2' }] });
    expect(JSON.stringify(cleaned)).not.toContain('t1');
    expect(JSON.stringify(cleaned)).not.toContain('t2');
  });

  it('счётчики токенов не редактируются: это расход, а не секрет', () => {
    // Слово «tokens» кончается на «s» — под суффикс «token» не попадает.
    const cleaned = scrubSecrets({ usage: { inputTokens: 1200, cacheHitTokens: 40 } });
    expect(JSON.stringify(cleaned)).toContain('1200');
    expect(JSON.stringify(cleaned)).toContain('40');
  });

  it('регистр имени поля не спасает секрет', () => {
    const cleaned = scrubSecrets({ Authorization: 'Bearer x', ApiKey: 'y' });
    expect(cleaned.Authorization).toBe(REDACTED);
    expect(cleaned.ApiKey).toBe(REDACTED);
  });
});

describe('канарейка лога прогонов', () => {
  it('тело поста и ключи не уезжают в лог даже целым объектом', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      stream: {
        write(line: string) {
          lines.push(line);
        },
      },
    });

    logger.info(
      {
        postId: 'p1',
        role: 'write',
        usdMicros: 1234,
        env: { apiKey: 'sk-secret-value', botToken: '123:AAA' },
        scrapeCreatorsApiKey: 'sc-secret',
      },
      'шаг конвейера завершён',
    );

    const line = lines[0] ?? '';
    expect(line).not.toContain('sk-secret-value');
    expect(line).not.toContain('123:AAA');
    expect(line).not.toContain('sc-secret');
    // Факты остаются полями, а не текстом сообщения.
    expect(line).toContain('"postId":"p1"');
    expect(line).toContain('"usdMicros":1234');
  });
});

describe('секрет внутри текста', () => {
  it('токен в адресе внутри сообщения об ошибке редактируется', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      stream: {
        write(line: string) {
          lines.push(line);
        },
      },
    });

    // Токен собирается из кусков: цельным литералом это читается как
    // «в коде лежит секрет» и для анализатора, и для человека.
    const token = ['7712345678', 'AAF-SECRET-TOKEN-VALUE-1234'].join(':');
    const error = new Error(`fetch to https://api.telegram.org/bot${token}/sendMessage failed`);
    logger.error({ err: error }, 'отправка не удалась');

    const line = lines[0] ?? '';
    expect(line).not.toContain('AAF-SECRET-TOKEN-VALUE-1234');
    expect(line).toContain('[Redacted]');
  });

  it('ключ модели в свободной строке тоже', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', stream: { write: (line: string) => lines.push(line) } });
    logger.warn({ note: 'ключ sk-abcdefghijklmnop отклонён' }, 'провайдер отказал');
    expect(lines[0] ?? '').not.toContain('sk-abcdefghijklmnop');
  });
});
