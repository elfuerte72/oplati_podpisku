import { z } from 'zod';

/**
 * Переменные окружения бота. Разбираются один раз при старте: недостающая
 * обязательная переменная роняет процесс с её именем, а не даёт боту подняться
 * и молча не работать. Прецедент — `ANTHROPIC_API_KEY` в проде: пропажа ключа
 * глушила пути, к модели отношения не имеющие.
 */
export class EnvError extends Error {
  override readonly name = 'EnvError';
}

/** Пустая строка = переменная не задана: docker и Dokploy передают незаполненное поле так. */
function withoutBlanks(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
  }
  return out;
}

/**
 * Целое БОЛЬШЕ нуля. Ноль отвергается намеренно: `SMM_OWNER_ID=0` дал бы бота,
 * который не слушается никого и при этом стартует зелёным, а
 * `SMM_GROUP_THREAD_*=0` — «корень группы вместо темы» без единого предупреждения.
 */
const positiveInt = (name: string) =>
  z
    .string()
    .regex(/^[1-9]\d*$/, `${name}: ожидается целое число больше нуля`)
    .transform((raw) => Number(raw));

/** chat_id канала или группы: числовой id (обычно -100…) либо @username. Адрес t.me Bot API не принимает. */
const chatRef = (name: string) =>
  z
    .string()
    .regex(/^(-?\d+|@[A-Za-z0-9_]{4,})$/, `${name}: нужен числовой id или @username, не ссылка`);

const schema = z.object({
  SMM_BOT_TOKEN: z.string().min(1),
  SMM_OWNER_ID: positiveInt('SMM_OWNER_ID'),
  SMM_CHANNEL_ID: chatRef('SMM_CHANNEL_ID'),
  // Имя канала нужно отдельно от id: просмотры читаются с витрины t.me/s/<имя>,
  // а Bot API просмотров не отдаёт вовсе.
  SMM_CHANNEL_USERNAME: z
    .string()
    .min(4)
    .transform((raw) => raw.replace(/^@/, ''))
    .refine((raw) => /^[A-Za-z0-9_]{4,}$/.test(raw), 'SMM_CHANNEL_USERNAME: только имя канала, без ссылки'),

  // Группа SMM: тема «Черновики» для превью, тема «Отчёты» для сводки. Не задана —
  // превью и сводка идут владельцу в личку (dev-режим), это не отказ.
  SMM_GROUP_ID: chatRef('SMM_GROUP_ID').optional(),
  SMM_GROUP_THREAD_DRAFTS: positiveInt('SMM_GROUP_THREAD_DRAFTS').optional(),
  SMM_GROUP_THREAD_REPORTS: positiveInt('SMM_GROUP_THREAD_REPORTS').optional(),

  SMM_MODEL_API_KEY: z.string().min(1),
  SMM_MODEL_BASE_URL: z.string().url().default('https://api.deepseek.com/anthropic'),
  // Роли берут модель из своей переменной: смена судьи на другую модель — правка
  // env, а не кода (спека, «Одна модель на все роли»).
  SMM_MODEL_WRITER: z.string().min(1).default('deepseek-flash'),
  SMM_MODEL_JUDGE: z.string().min(1).default('deepseek-flash'),
  SMM_MODEL_RANK: z.string().min(1).default('deepseek-flash'),

  TAVILY_API_KEY: z.string().min(1).optional(),
  SCRAPECREATORS_API_KEY: z.string().min(1).optional(),

  SMM_DB_PATH: z.string().min(1).default('data/smm.db'),
  SMM_IMAGES_DIR: z.string().min(1).default('data/images'),

  // Алёрты здоровья уходят через бота ВХОДА, а не через бота SMM (правило
  // ops-группы: в группу пишет один отправитель).
  OPS_BOT_TOKEN: z.string().min(1).optional(),
  OPS_GROUP_CHAT_ID: chatRef('OPS_GROUP_CHAT_ID').optional(),
  OPS_GROUP_THREAD_ERRORS: positiveInt('OPS_GROUP_THREAD_ERRORS').optional(),

  SENTRY_DSN: z.string().url().optional(),

  // Окно отмены публикации. Ноль означал бы «кнопки „Отменить“ нет», а решение
  // владельца ровно обратное: минута на передумать дешевле удалённого поста.
  SMM_PUBLISH_UNDO_SECONDS: positiveInt('SMM_PUBLISH_UNDO_SECONDS')
    .pipe(z.number().min(5, 'SMM_PUBLISH_UNDO_SECONDS: не меньше 5 секунд').max(600))
    .default('60'),

  SMM_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Тестовый канал для eval:live. Живой канал там указывать нельзя, поэтому
  // переменная отдельная, а не переиспользование SMM_CHANNEL_ID.
  SMM_EVAL_CHANNEL_ID: chatRef('SMM_EVAL_CHANNEL_ID').optional(),
});

export interface ModelEnv {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly writer: string;
  readonly judge: string;
  readonly rank: string;
}

export interface OpsEnv {
  readonly botToken?: string;
  readonly chatId?: string;
  readonly threadErrors?: number;
}

export interface SmmEnv {
  readonly botToken: string;
  readonly ownerId: number;
  readonly channelId: string;
  readonly channelUsername: string;
  readonly groupId?: string;
  readonly groupThreadDrafts?: number;
  readonly groupThreadReports?: number;
  readonly model: ModelEnv;
  readonly tavilyApiKey?: string;
  readonly scrapeCreatorsApiKey?: string;
  readonly dbPath: string;
  readonly imagesDir: string;
  readonly ops: OpsEnv;
  readonly sentryDsn?: string;
  readonly publishUndoSeconds: number;
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly evalChannelId?: string;
}

/** Текст падения: только ИМЕНА переменных и причина. Значения в лог не попадают — там секреты. */
function describe(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const name = issue.path.join('.') || 'env';
    if (issue.code === 'invalid_type' && issue.received === 'undefined') {
      return `${name}: не задана`;
    }
    return `${name}: ${issue.message}`;
  });
  const unique = [...new Set(lines)];
  return `Переменные окружения бота SMM заданы неверно:\n  ${unique.join('\n  ')}`;
}

export function loadEnv(source: Record<string, string | undefined> = process.env): SmmEnv {
  const parsed = schema.safeParse(withoutBlanks(source));
  if (!parsed.success) throw new EnvError(describe(parsed.error));
  const raw = parsed.data;
  return {
    botToken: raw.SMM_BOT_TOKEN,
    ownerId: raw.SMM_OWNER_ID,
    channelId: raw.SMM_CHANNEL_ID,
    channelUsername: raw.SMM_CHANNEL_USERNAME,
    groupId: raw.SMM_GROUP_ID,
    groupThreadDrafts: raw.SMM_GROUP_THREAD_DRAFTS,
    groupThreadReports: raw.SMM_GROUP_THREAD_REPORTS,
    model: {
      apiKey: raw.SMM_MODEL_API_KEY,
      baseUrl: raw.SMM_MODEL_BASE_URL,
      writer: raw.SMM_MODEL_WRITER,
      judge: raw.SMM_MODEL_JUDGE,
      rank: raw.SMM_MODEL_RANK,
    },
    tavilyApiKey: raw.TAVILY_API_KEY,
    scrapeCreatorsApiKey: raw.SCRAPECREATORS_API_KEY,
    dbPath: raw.SMM_DB_PATH,
    imagesDir: raw.SMM_IMAGES_DIR,
    ops: {
      botToken: raw.OPS_BOT_TOKEN,
      chatId: raw.OPS_GROUP_CHAT_ID,
      threadErrors: raw.OPS_GROUP_THREAD_ERRORS,
    },
    sentryDsn: raw.SENTRY_DSN,
    publishUndoSeconds: raw.SMM_PUBLISH_UNDO_SECONDS,
    logLevel: raw.SMM_LOG_LEVEL,
    evalChannelId: raw.SMM_EVAL_CHANNEL_ID,
  };
}
