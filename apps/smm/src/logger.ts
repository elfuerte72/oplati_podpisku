import pino, { type DestinationStream, type Logger } from 'pino';

export type { Logger };

/**
 * Имена полей, значения которых не уходят в лог никогда. Проверка идёт ПО ИМЕНИ
 * и рекурсивно, а не списком путей: у `redact` из pino подстановка `*` работает
 * ровно на один уровень, поэтому `logger.info({ env }, 'старт')` писал бы
 * `env.model.apiKey` открытым текстом, хотя `env.botToken` выглядел бы скрытым.
 * Ключ DeepSeek, уехавший в Loki, оттуда не отзывается.
 *
 * Тела постов тоже скрываются: пост до публикации видит только владелец, а
 * строки узла читают посторонние.
 */
export const SECRET_FIELDS = ['body', 'text', 'markdown', 'caption', 'dossier', 'pan', 'cvc', 'cvv'] as const;

/**
 * Окончания имён, по которым поле считается секретом. Суффикс, а не точное имя:
 * иначе `tavilyApiKey` и `scrapeCreatorsApiKey` проходят мимо списка `apikey`
 * (проверено — именно так они и утекли в первом варианте). Слово `tokens` под
 * правило не попадает: у него на конце `s`, а это счётчик расхода, не секрет.
 */
export const SECRET_SUFFIXES = [
  'token',
  'apikey',
  'key',
  'secret',
  'password',
  'authorization',
  'dsn',
] as const;

export const REDACTED = '[Redacted]';

const SECRETS = new Set<string>(SECRET_FIELDS);

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
  if (SECRETS.has(normalized)) return true;
  return SECRET_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * Похожее на секрет ВНУТРИ строки. Поле чистится по ИМЕНИ, но токен приезжает
 * и телом: `err.message` у grammY несёт адрес вида
 * `https://api.telegram.org/bot<токен>/sendMessage`, и он уезжал в лог целиком.
 */
const SECRET_IN_TEXT: readonly RegExp[] = [
  /bot\d{6,}:[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{10,}/g,
  /\b(?:tvly|sc)-[A-Za-z0-9_-]{10,}/g,
  /\b\d{6,}:[A-Za-z0-9_-]{30,}/g,
];

export function scrubText(text: string): string {
  let out = text;
  for (const pattern of SECRET_IN_TEXT) out = out.replace(pattern, REDACTED);
  return out;
}

/** Глубже не ходим: дерево глубже пяти уровней в лог не пишем, а цикл повесил бы процесс. */
const MAX_DEPTH = 6;

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return '[Depth]';
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1, seen));

  // Ошибка — не обычный объект: её собственные поля не перечисляемые, а pino
  // сериализует её своим сериализатором. Отдаём как есть, но с чищенными
  // собственными полями (у ошибок SDK там лежат request и headers).
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key] = isSecretKey(key) ? REDACTED : scrubValue(source[key], depth + 1, seen);
  }
  if (value instanceof Error) {
    out.type = value.name;
    // Текст и стек тоже чистятся: токен в адресе запроса живёт именно там.
    out.message = scrubText(value.message);
    out.stack = value.stack === undefined ? undefined : scrubText(value.stack);
  }
  return out;
}

/** Чистка объекта лога. Экспортируется ради канареек: правило проверяется, а не обещается. */
export function scrubSecrets(record: Record<string, unknown>): Record<string, unknown> {
  return scrubValue(record, 0, new WeakSet()) as Record<string, unknown>;
}

export interface LoggerOptions {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** Куда писать. По умолчанию stdout: логи узла собирает Loki из docker logs. */
  readonly stream?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      // Уровень строкой: читать «level":"error"» в Loki проще, чем «level":50».
      formatters: {
        level: (label) => ({ level: label }),
        log: (record) => scrubSecrets(record),
      },
      base: { app: 'smm' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    // sync: объём строк у бота крошечный, а потеря последней строки перед
    // process.exit дороже микросекунд записи.
    options.stream ?? pino.destination({ dest: 1, sync: true }),
  );
}
