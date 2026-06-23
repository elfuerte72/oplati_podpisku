import { describe, expect, it } from 'vitest';

import { formatSentryAlertMessage, sentryAlertPayloadSchema } from './sentry.ts';

describe('sentryAlertPayloadSchema', () => {
  it('парсит реалистичный legacy-webhook payload', () => {
    const res = sentryAlertPayloadSchema.safeParse({
      project_name: 'oplati-web',
      level: 'error',
      url: 'https://sentry.io/issues/123/',
      triggering_rules: ['High priority issues'],
      event: {
        title: 'PaySpaceApiError: insufficient funds',
        environment: 'production',
        level: 'error',
        web_url: 'https://sentry.io/issues/123/events/abc/',
      },
    });
    expect(res.success).toBe(true);
  });

  it('терпит лишние/отсутствующие поля (всё optional + passthrough)', () => {
    expect(sentryAlertPayloadSchema.safeParse({}).success).toBe(true);
    expect(sentryAlertPayloadSchema.safeParse({ foo: 'bar' }).success).toBe(true);
  });

  it('отклоняет не-объект (массив/строка)', () => {
    expect(sentryAlertPayloadSchema.safeParse('oops').success).toBe(false);
    expect(sentryAlertPayloadSchema.safeParse([1, 2]).success).toBe(false);
  });
});

describe('formatSentryAlertMessage', () => {
  it('собирает сообщение из title/level/project/env/url', () => {
    const msg = formatSentryAlertMessage({
      project_name: 'oplati-web',
      level: 'error',
      url: 'https://sentry.io/issues/123/',
      triggering_rules: ['High priority'],
      event: {
        title: 'PaySpaceApiError: insufficient funds',
        environment: 'production',
      },
    });
    expect(msg).toContain('Sentry · ОШИБКА');
    expect(msg).toContain('PaySpaceApiError: insufficient funds');
    expect(msg).toContain('Проект: oplati-web');
    expect(msg).toContain('Окружение: production');
    expect(msg).toContain('Правило: High priority');
    expect(msg).toContain('https://sentry.io/issues/123/');
  });

  it('фоллбэчит title и level при отсутствии event', () => {
    const msg = formatSentryAlertMessage({ message: 'something broke' });
    expect(msg).toContain('Sentry · ОШИБКА'); // level по умолчанию error
    expect(msg).toContain('something broke');
    expect(msg).toContain('Проект: —');
  });

  it('обрезает слишком длинный title', () => {
    const long = 'x'.repeat(500);
    const msg = formatSentryAlertMessage({ event: { title: long } });
    expect(msg).toContain('…');
    expect(msg.length).toBeLessThan(500);
  });
});
