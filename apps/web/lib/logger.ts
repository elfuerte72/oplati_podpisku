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
// `||`, а не `??`: `LOG_LEVEL=` — это «не задано», а пустая строка уронила бы
// pino на старте (валидный уровень он требует строго).
const defaultLevel = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info');

/**
 * Экспортируется ради canary-теста: список путей — это защита от утечки PII,
 * и его сужение должно ронять тест, а не выясняться в проде по логам.
 */
export const redactPaths: string[] = [
  // headers
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'headers["x-telegram-bot-api-secret-token"]',
  // Альтернативный способ авторизации алёрт-вебхука Sentry: вариант `?s=` уже
  // закрыт, заголовок оставался открытым (находка ревью).
  'req.headers["x-alert-token"]',
  'headers["x-alert-token"]',
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
  'env.SENTRY_AUTH_TOKEN',
  'env.UPSTASH_REDIS_REST_TOKEN',
  // PII denylist из docs/observability.md (на границах request body)
  '*.content',
  '*.text',
  '*.email',
  '*.phone',
  '*.card',
  // Антифрод-трек (Р5): контакты и адрес клиента уходят провайдеру, но не в
  // логи — режим PAN. `tel` — имя поля в исходящем запросе Freekassa,
  // `last_seen_ip` — колонка users (IP клиента = PII по GDPR-логике).
  '*.tel',
  '*.last_seen_ip',
  '*.lastSeenIp',
  'body.tel',
  // Карточные реквизиты и auth-строки (аудит 2026-07-11 F-06): первичная защита —
  // код никогда их не логирует (card-secrets.ts, non-enumerable rawBody); это
  // страховочный слой на случай будущего рефакторинга. pan_masked НЕ редактируем
  // (маскированный PAN — легитимный идентификатор в логах).
  // Тело запроса grammY: `GrammyError.payload` — ПЕРЕЧИСЛЯЕМОЕ поле, и pino
  // сериализует его вместе с ошибкой. В сообщении о выпуске карты там лежат
  // полный PAN и CVC, а путь `*.text` до `err.payload.text` не достаёт: у него
  // глубина 2. Первичная защита — не логировать такие ошибки целиком
  // (`jobs/issue-card.ts` → `logSendFailure`), это страховка на будущий код.
  '*.payload.text',
  '*.payload.caption',
  'err.payload',
  // Ошибка postgres-js — `Object.assign(this, x)`, то есть её перечисляемые
  // поля сериализуются pino вместе с ней. При нарушении constraint Postgres
  // кладёт в `detail` строку «Failing row contains (…)» — ЦЕЛУЮ строку
  // таблицы: комментарий оператора, контакты клиента, что угодно. `query` и
  // `params` несут тот же риск (находка ревью пачки 3 админ-панели).
  'err.detail',
  'err.where',
  'err.query',
  'err.params',
  '*.err.detail',
  '*.err.where',
  '*.err.query',
  '*.err.params',
  '*.pan',
  '*.cvc',
  '*.cvv',
  '*.cardNo',
  '*.card_no',
  '*.initData',
  '*.init_data',
  '*.signature',
  // Freekassa: `payer_account` — счёт/карта плательщика в уведомлении. Код его
  // не логирует (в `payments.raw_payload` уходит только маска, см.
  // `toStorableNotification`), это страховочный слой на будущий рефакторинг.
  '*.payer_account',
  '*.SIGN',
  'body.content',
  'body.text',
  'body.message',
  'body.email',
  'body.phone',
  'body.card',
  // Страховка: сырое тело ответа PaySpace (может содержать полный PAN/CVV) не
  // должно попадать в лог, даже если ошибку залогируют с ним. Первичная защита —
  // неперечисляемое `rawBody` в PaySpaceContractError; это второй слой.
  'err.rawBody',
  '*.rawBody',
];

const baseOptions: LoggerOptions = {
  level: defaultLevel,
  base: {
    service: 'oplati-web',
    env: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
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
