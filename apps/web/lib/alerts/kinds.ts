/**
 * Потоки уведомлений (темы ops-группы) и их маркеры. Отдельный лист без
 * `server-only`: его читают и доставка (`streams.ts`), и чистый шаблон текста
 * (`format.ts`), и скрипт образцов.
 */

export const ALERT_STREAMS = ['critical', 'payments', 'support', 'errors', 'deploy'] as const;

export type AlertStream = (typeof ALERT_STREAMS)[number];

/**
 * Маркер потока в первой строке сообщения — тот же значок, что у темы группы.
 * В теме он дублирует название, зато в корне группы и в личке (режим без
 * группы, фолбэк) сразу говорит, авария это или «к сведению».
 */
export const STREAM_MARKERS: Readonly<Record<AlertStream, string>> = {
  critical: '🔴',
  payments: '💳',
  support: '🎧',
  errors: '⚠️',
  deploy: '🚀',
};
