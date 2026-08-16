import { z } from 'zod';

/**
 * Парсинг и форматирование payload'а Sentry alert-webhook.
 *
 * Форматов ДВА, и они не похожи друг на друга:
 *
 *  1. **Legacy webhook** («Send a notification via a webhook») — всё на верхнем
 *     уровне: `project_name`, `culprit`, `url`, `triggering_rules`, `event`.
 *  2. **Internal integration** (Sentry-app как действие правила) — конверт
 *     `{action, data: {event, triggered_rule, issue_alert}, installation}`:
 *     событие лежит на два уровня глубже, `environment` прямым полем НЕ
 *     приходит (только в `tags` парами `[ключ, значение]`), а имени проекта в
 *     payload'е нет вовсе — `event.project` это числовой id.
 *     Контракт: <https://docs.sentry.io/organization/integrations/integration-platform/webhooks/issue-alerts/>
 *
 * ⚠️ На проде работает формат (2) — интеграция `telegram-alerts-d8df3a`,
 * добавленная действием в правило `644412` (`runbooks/monitoring.md`), — а
 * парсер до 2026-08-16 знал только (1). Схема всё-optional + passthrough,
 * поэтому payload проходил валидацию, и владельцу приезжало «Sentry issue /
 * Проект: — / Окружение: —»: без названия ошибки, без места и без ссылки. По
 * такому сообщению нельзя ни понять проблему, ни найти её в Sentry — три таких
 * подряд пришли во время инцидента с nonce и выглядели ровно как шум.
 * Тесты этого не ловили: они были написаны по формату (1).
 *
 * Поэтому здесь поддержаны ОБА формата, а неизвестные поля не печатаются
 * прочерком: строка «Окружение: —» не несёт информации, её отсутствие — несёт.
 */

const sentryEventSchema = z
  .object({
    title: z.string().optional(),
    message: z.string().optional(),
    culprit: z.string().optional(),
    level: z.string().optional(),
    /** Прямым полем есть только у legacy; у internal integration — в `tags`. */
    environment: z.string().optional(),
    web_url: z.string().optional(),
    issue_url: z.string().optional(),
    /**
     * `unknown[]`, а не типизированный кортеж, намеренно: тег неожиданной формы
     * провалил бы разбор ВСЕГО payload'а, и алёрт был бы молча потерян (route
     * отдаёт 200 и не шлёт). Форму разбирает `environmentFromTags` — точечно и
     * без исключений.
     */
    tags: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const sentryAlertPayloadSchema = z
  .object({
    // Формат 1 — legacy webhook.
    project_name: z.string().optional(),
    project: z.string().optional(),
    culprit: z.string().optional(),
    level: z.string().optional(),
    message: z.string().optional(),
    url: z.string().optional(),
    triggering_rules: z.array(z.string()).optional(),
    event: sentryEventSchema.optional(),
    // Формат 2 — internal integration.
    data: z
      .object({
        event: sentryEventSchema.optional(),
        triggered_rule: z.string().optional(),
        issue_alert: z.object({ title: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type SentryAlertPayload = z.infer<typeof sentryAlertPayloadSchema>;

const LEVEL_LABEL: Record<string, string> = {
  fatal: 'СТОП',
  error: 'ОШИБКА',
  warning: 'ВНИМАНИЕ',
  info: 'ИНФО',
  debug: 'DEBUG',
};

const MAX_TITLE = 300;
const FALLBACK_TITLE = 'Sentry issue';

/**
 * `environment` из `tags`. Sentry шлёт теги парами `["environment","production"]`
 * (доказано примером в доке), но в части ответов API — объектами
 * `{key, value}`; принимаем обе формы и молча пропускаем всё остальное.
 */
function environmentFromTags(tags: unknown[] | undefined): string | null {
  if (!tags) return null;
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === 'environment' && typeof tag[1] === 'string') {
      return tag[1];
    }
    if (tag !== null && typeof tag === 'object' && !Array.isArray(tag)) {
      const { key, value } = tag as { key?: unknown; value?: unknown };
      if (key === 'environment' && typeof value === 'string') return value;
    }
  }
  return null;
}

/**
 * Короткое человекочитаемое сообщение для Telegram. Без HTML/Markdown-разметки
 * (шлём plain text, чтобы спецсимволы в title не ломали парсинг). Ссылка —
 * последней строкой.
 *
 * `degraded` = из payload'а не удалось достать даже название проблемы. Сообщение
 * всё равно уходит (молча проглотить алёрт хуже, чем прислать невнятный), но
 * вызывающий обязан это залогировать: единственный признак, что Sentry снова
 * сменил формат, — именно он.
 */
export function formatSentryAlertMessage(p: SentryAlertPayload): {
  text: string;
  degraded: boolean;
} {
  const ev = p.data?.event ?? p.event ?? {};

  const level = (p.level ?? ev.level ?? 'error').toLowerCase();
  const label = LEVEL_LABEL[level] ?? level.toUpperCase();

  const rawTitle = ev.title ?? ev.message ?? p.message ?? ev.culprit ?? p.culprit;
  const degraded = rawTitle === undefined || rawTitle.trim() === '';
  const title = degraded
    ? FALLBACK_TITLE
    : rawTitle.length > MAX_TITLE
      ? `${rawTitle.slice(0, MAX_TITLE)}…`
      : rawTitle;

  // «Где» дублировало бы заголовок, если тот сам собрался из culprit.
  const culprit = ev.culprit ?? p.culprit;
  const where = culprit && culprit !== title ? culprit : null;

  const environment = ev.environment ?? environmentFromTags(ev.tags);
  // Имя проекта есть только в legacy-формате; числовой id из internal
  // integration человеку бесполезен, поэтому его не печатаем.
  const project = p.project_name ?? p.project ?? null;
  const rule = p.triggering_rules?.length
    ? p.triggering_rules.join(', ')
    : (p.data?.triggered_rule ?? p.data?.issue_alert?.title ?? null);
  const link = ev.web_url ?? p.url ?? ev.issue_url ?? null;

  const lines = [`Sentry · ${label}`, title, ''];
  if (where) lines.push(`Где: ${where}`);
  if (environment) lines.push(`Окружение: ${environment}`);
  if (project) lines.push(`Проект: ${project}`);
  if (rule) lines.push(`Правило: ${rule}`);
  if (link) lines.push('', link);

  return { text: lines.join('\n'), degraded };
}
