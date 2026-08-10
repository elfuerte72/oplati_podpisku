import type * as SentryTypes from '@sentry/nextjs';

/**
 * Общие хелперы Sentry для client/server/edge.
 *
 * Основная задача — `beforeSend`-скраббер, который вычищает PII по денилисту
 * из `docs/observability.md`:
 *   content, message, text, email, phone, card, password, token.
 *
 * Применяется на всех трёх runtime'ах (client/server/edge).
 */

// Карточные реквизиты (pan/cvc/cvv/cardNo) и auth-строки (initData/signature) —
// аудит 2026-07-11 F-06: страховочный слой, код их в Sentry не отправляет.
const PII_KEY_RE =
  /^(content|message|text|email|phone|card|password|token|pan|cvc|cvv|card_?no|init_?data|signature)$/i;

/** Рекурсивно редактирует значения PII-полей во вложенных объектах. */
function scrubPii(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => scrubPii(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = PII_KEY_RE.test(k) ? '[REDACTED]' : scrubPii(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type SentryEvent = SentryTypes.ErrorEvent;
export type SentryHint = SentryTypes.EventHint;

export function beforeSend(event: SentryEvent): SentryEvent | null {
  // Request body / query / headers — денилист PII
  if (event.request) {
    if (event.request.data) {
      event.request.data = scrubPii(event.request.data) as typeof event.request.data;
    }
    if (event.request.query_string && typeof event.request.query_string === 'string') {
      event.request.query_string = event.request.query_string
        .replace(
          /(content|message|text|email|phone|card|password|token|signature|init_?data)=[^&]*/gi,
          '$1=[REDACTED]',
        )
        // `?s=` — секрет алёрт-вебхука Sentry (/api/alerts/sentry). Отдельным
        // выражением с якорем на границу параметра, чтобы не задевать `tags=` и т.п.
        .replace(/(^|[?&])s=[^&]*/gi, '$1s=[REDACTED]');
    }
    if (event.request.headers) {
      const headers = event.request.headers as Record<string, string>;
      for (const key of Object.keys(headers)) {
        // `x-telegram-init-data` — подписанная initData Mini App: живёт 24 часа
        // и её достаточно для `/api/cabinet` `card-details`, то есть для показа
        // PAN+CVC чужой карты. `/api/cabinet` возит её в ТЕЛЕ (там ловит
        // денилист `init_?data`), а `/api/analytics` — заголовком, поэтому без
        // этого имени в списке она уезжала бы в Sentry целиком (найдено
        // ревью 2026-07-30).
        if (
          /authorization|cookie|x-telegram-bot-api-secret-token|x-alert-token|x-telegram-init-data/i.test(
            key,
          )
        ) {
          headers[key] = '[REDACTED]';
        }
      }
    }
  }

  // Breadcrumbs
  if (event.breadcrumbs) {
    for (const crumb of event.breadcrumbs) {
      if (crumb.data) {
        crumb.data = scrubPii(crumb.data) as typeof crumb.data;
      }
      if (crumb.message) {
        // превентивная обрезка потенциальных токенов в сообщениях
        crumb.message = crumb.message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]');
      }
    }
  }

  // Extra / contexts
  if (event.extra) {
    event.extra = scrubPii(event.extra) as typeof event.extra;
  }

  return event;
}

export function resolveEnvironment(): 'development' | 'preview' | 'production' | string {
  return process.env.VERCEL_ENV || process.env.NODE_ENV || 'development';
}

/** Экспорт для явного импорта в sentry.*.config.ts. */
export const sharedOptions = {
  environment: resolveEnvironment(),
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  beforeSend,
} as const;
