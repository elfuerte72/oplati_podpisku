import { z } from 'zod';

/**
 * Парсинг и форматирование payload'а Sentry alert-webhook.
 *
 * Источник — экшен alert rule «Send a notification via a webhook» (legacy
 * webhook). Формат у Sentry плавает (часть полей то на верхнем уровне, то в
 * `event`), поэтому схема максимально терпимая: всё optional + `passthrough`,
 * нам нужны только title / level / окружение / ссылка. Невалидный объект → null
 * у вызывающего (route отдаёт 200, не падает).
 */

const sentryEventSchema = z
  .object({
    title: z.string().optional(),
    message: z.string().optional(),
    level: z.string().optional(),
    environment: z.string().optional(),
    web_url: z.string().optional(),
    issue_url: z.string().optional(),
  })
  .passthrough();

export const sentryAlertPayloadSchema = z
  .object({
    project_name: z.string().optional(),
    project: z.string().optional(),
    culprit: z.string().optional(),
    level: z.string().optional(),
    message: z.string().optional(),
    url: z.string().optional(),
    triggering_rules: z.array(z.string()).optional(),
    event: sentryEventSchema.optional(),
  })
  .passthrough();

export type SentryAlertPayload = z.infer<typeof sentryAlertPayloadSchema>;

const LEVEL_EMOJI: Record<string, string> = {
  fatal: 'СТОП',
  error: 'ОШИБКА',
  warning: 'ВНИМАНИЕ',
  info: 'ИНФО',
  debug: 'DEBUG',
};

const MAX_TITLE = 300;

/**
 * Короткое человекочитаемое сообщение для Telegram. Без HTML/Markdown-разметки
 * (шлём как plain text, чтобы спецсимволы в title не ломали парсинг). Ссылку на
 * issue кладём последней строкой.
 */
export function formatSentryAlertMessage(p: SentryAlertPayload): string {
  const ev = p.event ?? {};
  const level = (p.level ?? ev.level ?? 'error').toLowerCase();
  const label = LEVEL_EMOJI[level] ?? level.toUpperCase();
  const rawTitle = ev.title ?? p.message ?? p.culprit ?? 'Sentry issue';
  const title = rawTitle.length > MAX_TITLE ? `${rawTitle.slice(0, MAX_TITLE)}…` : rawTitle;
  const environment = ev.environment ?? '—';
  const project = p.project_name ?? p.project ?? '—';
  const link = p.url ?? ev.web_url ?? ev.issue_url ?? '';
  const rules = p.triggering_rules?.length ? p.triggering_rules.join(', ') : null;

  const lines = [
    `Sentry · ${label}`,
    title,
    '',
    `Проект: ${project}`,
    `Окружение: ${environment}`,
  ];
  if (rules) lines.push(`Правило: ${rules}`);
  if (link) lines.push('', link);
  return lines.join('\n');
}
