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

const PII_KEY_RE = /^(content|message|text|email|phone|card|password|token)$/i;

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
      event.request.query_string = event.request.query_string.replace(
        /(content|message|text|email|phone|card|password|token)=[^&]*/gi,
        '$1=[REDACTED]',
      );
    }
    if (event.request.headers) {
      const headers = event.request.headers as Record<string, string>;
      for (const key of Object.keys(headers)) {
        if (/authorization|cookie|x-telegram-bot-api-secret-token/i.test(key)) {
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
  return process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development';
}

/** Экспорт для явного импорта в sentry.*.config.ts. */
export const sharedOptions = {
  environment: resolveEnvironment(),
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  beforeSend,
} as const;
