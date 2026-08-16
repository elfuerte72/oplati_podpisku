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

/**
 * Поле внешнего payload'а: `.nullish()`, а НЕ `.optional()`.
 *
 * Sentry для незаполненных полей шлёт `null`, а не пропускает ключ (в примере
 * доки так приходят `dist`, `release`, `culprit`). `.optional()` принимает
 * только `undefined`, поэтому ОДИН `null` роняет разбор ВСЕГО payload'а — и
 * алёрт молча теряется (`route.ts` отвечает `200 skipped:'invalid_payload'`).
 * Ровно та же логика, по которой `tags` объявлены `unknown[]`: на внешней
 * границе строгость оборачивается не «поймали дрейф», а «потеряли алёрт».
 */
const externalString = () => z.string().nullish();

const sentryEventSchema = z
  .object({
    title: externalString(),
    message: externalString(),
    culprit: externalString(),
    level: externalString(),
    /** Прямым полем есть только у legacy; у internal integration — в `tags`. */
    environment: externalString(),
    web_url: externalString(),
    issue_url: externalString(),
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
    project_name: externalString(),
    project: externalString(),
    culprit: externalString(),
    level: externalString(),
    message: externalString(),
    url: externalString(),
    triggering_rules: z.array(z.string()).nullish(),
    event: sentryEventSchema.nullish(),
    // Формат 2 — internal integration.
    data: z
      .object({
        event: sentryEventSchema.nullish(),
        triggered_rule: externalString(),
        issue_alert: z.object({ title: externalString() }).passthrough().nullish(),
      })
      .passthrough()
      .nullish(),
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

/** Первое непустое строковое значение; `null`/`undefined`/пробелы — не значение. */
function firstFilled(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function clamp(value: string): string {
  return value.length > MAX_TITLE ? `${value.slice(0, MAX_TITLE)}…` : value;
}

/**
 * `environment` из `tags`. Sentry шлёт теги парами `["environment","production"]`
 * (доказано примером в доке), но в части ответов API — объектами
 * `{key, value}`; принимаем обе формы и молча пропускаем всё остальное.
 */
function environmentFromTags(tags: unknown[] | null | undefined): string | null {
  if (!tags) return null;
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === 'environment' && typeof tag[1] === 'string') {
      return tag[1];
    }
    if (tag !== null && typeof tag === 'object' && !Array.isArray(tag) && 'key' in tag && 'value' in tag) {
      const { key, value } = tag;
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

  // Через firstFilled, а не `??`: пустая строка в payload'е — это тоже
  // «значения нет», иначе заголовок вышел бы «Sentry · » без уровня.
  const level = (firstFilled(p.level, ev.level) ?? 'error').toLowerCase();
  const label = LEVEL_LABEL[level] ?? level.toUpperCase();

  const rawTitle = firstFilled(ev.title, ev.message, p.message, ev.culprit, p.culprit);
  const degraded = rawTitle === null;
  const title = clamp(rawTitle ?? FALLBACK_TITLE);

  // «Где» сравнивается с СЫРЫМ заголовком, а не с обрезанным: у длинного
  // culprit'а, ставшего заголовком, обрезок с ним не совпал бы, и сообщение
  // получило бы его второй раз целиком. Обрезаем и его — Telegram отвергает
  // сообщения длиннее ~4096 символов ЦЕЛИКОМ, то есть одно распухшее поле
  // внешнего payload'а стоило бы нам всего алёрта.
  const culprit = firstFilled(ev.culprit, p.culprit);
  const where = culprit !== null && culprit !== rawTitle ? clamp(culprit) : null;

  const environment = firstFilled(ev.environment, environmentFromTags(ev.tags));
  // Имя проекта есть только в legacy-формате; числовой id из internal
  // integration человеку бесполезен, поэтому его не печатаем.
  const project = firstFilled(p.project_name, p.project);
  const rule = p.triggering_rules?.length
    ? p.triggering_rules.join(', ')
    : firstFilled(p.data?.triggered_rule, p.data?.issue_alert?.title);
  const link = firstFilled(ev.web_url, p.url, ev.issue_url);

  const lines = [`Sentry · ${label}`, title, ''];
  if (where) lines.push(`Где: ${where}`);
  if (environment) lines.push(`Окружение: ${environment}`);
  if (project) lines.push(`Проект: ${project}`);
  if (rule) lines.push(`Правило: ${rule}`);
  if (link) lines.push('', link);

  return { text: lines.join('\n'), degraded };
}
