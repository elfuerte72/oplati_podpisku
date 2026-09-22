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
    // ⚠️ В лог уходит ДВОЙНИК той же формы, а не результат `loadEnv`: разбор
    // env — признанный источник секретов, и запись его в лог анализатор
    // справедливо считает утечкой (CodeQL на PR #235), даже когда значения
    // выдуманные. Форма двойника сверяется с настоящим env ниже — разойдутся,
    // и канарейка это поймает.
    const secrets = {
      botToken: 'BOTTOKEN-123',
      modelApiKey: 'MODELKEY-456',
      opsBotToken: 'OPSTOKEN-789',
      tavilyApiKey: 'TAVILY-000',
      scrapeCreatorsApiKey: 'SCRAPE-111',
    };
    const envLike = {
      botToken: secrets.botToken,
      ownerId: 1,
      channelId: '-100123',
      channelUsername: 'ooplatishka',
      model: { apiKey: secrets.modelApiKey, writer: 'deepseek-flash' },
      ops: { botToken: secrets.opsBotToken, chatId: '-100999' },
      tavilyApiKey: secrets.tavilyApiKey,
      scrapeCreatorsApiKey: secrets.scrapeCreatorsApiKey,
    };

    const { logger, out } = capture();
    logger.info({ env: envLike }, 'старт');
    const line = out();
    for (const secret of Object.values(secrets)) {
      expect(line).not.toContain(secret);
    }

    // Двойник обязан повторять форму настоящего env: иначе он проверяет
    // выдуманный объект, а поле с ключом уезжает в лог незамеченным.
    const real = loadEnv({
      SMM_BOT_TOKEN: 'x',
      SMM_OWNER_ID: '1',
      SMM_CHANNEL_ID: '-100123',
      SMM_CHANNEL_USERNAME: 'ooplatishka',
      SMM_MODEL_API_KEY: 'y',
      OPS_BOT_TOKEN: 'z',
      OPS_GROUP_CHAT_ID: '-100999',
      TAVILY_API_KEY: 'a',
      SCRAPECREATORS_API_KEY: 'b',
    });
    for (const key of Object.keys(envLike)) {
      expect(Object.keys(real), `в env нет поля ${key}`).toContain(key);
    }
    expect(Object.keys(real.model)).toContain('apiKey');
    expect(Object.keys(real.ops)).toContain('botToken');
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
