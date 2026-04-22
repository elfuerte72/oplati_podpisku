import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * Structured JSON logger (pino) for apps/web.
 *
 * Правила:
 * - JSON stdout во всех окружениях (Vercel агрегирует); pino-pretty — только в локальном dev.
 * - verbose (debug) в development/preview, info в production.
 * - Никогда не логировать секреты и PII; redact-пути синхронизированы с денилистом
 *   из docs/observability.md (`content, message, text, email, phone, card, password, token`).
 * - Использовать `logger.child({ module: 'name' })` для scoped-логгеров.
 */

const isDev = process.env.NODE_ENV !== 'production';
const defaultLevel = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info');

const redactPaths: string[] = [
  // headers
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'headers["x-telegram-bot-api-secret-token"]',
  // secrets
  '*.password',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.secret',
  '*.authorization',
  'env.SUPABASE_SERVICE_ROLE_KEY',
  'env.ANTHROPIC_API_KEY',
  'env.TELEGRAM_BOT_TOKEN',
  'env.YOOKASSA_SECRET_KEY',
  'env.CRYPTOBOT_TOKEN',
  'env.SENTRY_AUTH_TOKEN',
  'env.UPSTASH_REDIS_REST_TOKEN',
  // PII denylist из docs/observability.md (на границах request body)
  '*.content',
  '*.text',
  '*.email',
  '*.phone',
  '*.card',
  'body.content',
  'body.text',
  'body.message',
  'body.email',
  'body.phone',
  'body.card',
];

const baseOptions: LoggerOptions = {
  level: defaultLevel,
  base: {
    service: 'oplati-web',
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
    remove: false,
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
};

// pino-pretty только локально; на Vercel — чистый JSON stdout.
const transport =
  isDev && !process.env.VERCEL
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
          singleLine: false,
        },
      })
    : undefined;

export const logger: Logger = transport ? pino(baseOptions, transport) : pino(baseOptions);

// self-test — подтверждает, что logger поднялся на этапе импорта
logger.debug({ event: 'logger.ready', level: defaultLevel, isDev });

/** Создать дочерний логгер с меткой модуля. */
export function childLogger(module: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ module, ...bindings });
}

export type { Logger };
