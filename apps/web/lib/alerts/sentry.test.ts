import { describe, expect, it } from 'vitest';

import { formatSentryAlertMessage, sentryAlertPayloadSchema } from './sentry.ts';

/**
 * Payload internal integration — форма по доке Sentry (issue-alerts webhook),
 * поля из живого инцидента 2026-08-15. Именно на нём ломался прежний парсер.
 */
const INTERNAL_INTEGRATION = {
  action: 'triggered',
  installation: { uuid: 'a8e5d37a-696c-4c54-adb5-b3f28d64c7de' },
  data: {
    event: {
      event_id: 'e4874d664c3540c1a32eab185f12c5ab',
      issue_id: '1117540176',
      project: 1,
      level: 'error',
      title: 'FreekassaApiError: Request with same (or bigger) nonce already exist',
      culprit: 'GET /api/cron/poll-payment',
      tags: [
        ['level', 'error'],
        ['environment', 'production'],
        ['url', 'https://www.oplatishka.com/api/cron/poll-payment'],
      ],
      issue_url: 'https://sentry.io/api/0/issues/1117540176/',
      url: 'https://sentry.io/api/0/projects/oplatishka/web/events/e4874d664c/',
      web_url: 'https://oplatishka.sentry.io/issues/1117540176/events/e4874d664c/',
    },
    triggered_rule: 'Send a notification for high priority issues',
    issue_alert: { title: 'Send a notification for high priority issues' },
  },
};

const LEGACY = {
  project_name: 'oplati-web',
  level: 'error',
  url: 'https://sentry.io/issues/123/',
  triggering_rules: ['High priority'],
  event: {
    title: 'PaySpaceApiError: insufficient funds',
    environment: 'production',
  },
};

describe('sentryAlertPayloadSchema', () => {
  it('парсит оба формата и СОХРАНЯЕТ поля', () => {
    // Проверяем именно значения: схема all-optional + passthrough принимает
    // любой объект, поэтому `success === true` был бы зелёным даже после
    // удаления всего блока `data` — тест, который нельзя провалить.
    const internal = sentryAlertPayloadSchema.safeParse(INTERNAL_INTEGRATION);
    expect(internal.success).toBe(true);
    expect(internal.success && internal.data.data?.event?.title).toContain('FreekassaApiError');
    expect(internal.success && internal.data.data?.triggered_rule).toBe(
      'Send a notification for high priority issues',
    );

    const legacy = sentryAlertPayloadSchema.safeParse(LEGACY);
    expect(legacy.success).toBe(true);
    expect(legacy.success && legacy.data.event?.title).toBe('PaySpaceApiError: insufficient funds');
  });

  it('РЕГРЕСС: null в поле не роняет разбор — Sentry так шлёт пустые поля', () => {
    // `.optional()` принимает только undefined, поэтому один `culprit: null`
    // отправлял ВЕСЬ payload в invalid_payload, и алёрт терялся молча.
    const res = sentryAlertPayloadSchema.safeParse({
      action: 'triggered',
      data: {
        event: { title: 'boom', culprit: null, environment: null, level: 'error' },
        triggered_rule: null,
      },
    });

    expect(res.success).toBe(true);
    expect(res.success && res.data.data?.event?.title).toBe('boom');
  });

  it('тег неожиданной формы не роняет разбор — иначе алёрт потерялся бы молча', () => {
    const res = sentryAlertPayloadSchema.safeParse({
      data: { event: { title: 'boom', tags: [{ key: 'environment', value: 'production' }, 42, null] } },
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
  it('РЕГРЕСС инцидента 2026-08-16: internal integration даёт название, место, окружение и ссылку', () => {
    const { text, degraded } = formatSentryAlertMessage(INTERNAL_INTEGRATION);

    expect(degraded).toBe(false);
    expect(text).toContain('Sentry · ОШИБКА');
    expect(text).toContain('FreekassaApiError: Request with same (or bigger) nonce already exist');
    expect(text).toContain('Где: GET /api/cron/poll-payment');
    // environment прямым полем не приходит — только из tags.
    expect(text).toContain('Окружение: production');
    expect(text).toContain('Правило: Send a notification for high priority issues');
    // Ссылка — человеческая (web_url), а не API-эндпоинт из event.url.
    expect(text).toContain('https://oplatishka.sentry.io/issues/1117540176/events/e4874d664c/');
    expect(text).not.toContain('api/0/');
    // Прежнее поведение, из-за которого сообщения были бесполезны.
    expect(text).not.toContain('—');
  });

  it('legacy-формат по-прежнему разбирается полностью', () => {
    const { text, degraded } = formatSentryAlertMessage(LEGACY);

    expect(degraded).toBe(false);
    expect(text).toContain('PaySpaceApiError: insufficient funds');
    expect(text).toContain('Проект: oplati-web');
    expect(text).toContain('Окружение: production');
    expect(text).toContain('Правило: High priority');
    expect(text).toContain('https://sentry.io/issues/123/');
  });

  it('неизвестные поля не печатаются прочерком: строки просто нет', () => {
    const { text } = formatSentryAlertMessage({ event: { title: 'boom' } });

    expect(text).toContain('boom');
    expect(text).not.toContain('Окружение');
    expect(text).not.toContain('Проект');
    expect(text).not.toContain('Правило');
  });

  it('нет ни названия, ни сообщения → degraded (сигнал, что формат снова уехал)', () => {
    const { text, degraded } = formatSentryAlertMessage({ data: { triggered_rule: 'Rule' } });

    expect(degraded).toBe(true);
    expect(text).toContain('Sentry issue');
    // Алёрт всё равно уходит: молча проглотить его хуже, чем прислать невнятный.
    expect(text).toContain('Правило: Rule');
  });

  it('«Где» не дублирует заголовок, если тот сам собрался из culprit', () => {
    const { text } = formatSentryAlertMessage({ event: { culprit: 'GET /api/bot' } });

    expect(text).toContain('GET /api/bot');
    expect(text).not.toContain('Где:');
  });

  it('длинный culprit-заголовок не печатается вторым разом и обрезается', () => {
    // Сравнение «Где» с УЖЕ обрезанным заголовком не совпало бы, и сообщение
    // получило бы тот же текст целиком второй раз.
    const { text } = formatSentryAlertMessage({ event: { culprit: 'y'.repeat(500) } });

    expect(text).not.toContain('Где:');
    expect(text.length).toBeLessThan(400);
  });

  it('распухшее поле payload’а не съедает алёрт целиком (лимит Telegram)', () => {
    const { text } = formatSentryAlertMessage({
      event: { title: 'boom', culprit: 'z'.repeat(9000) },
    });

    expect(text).toContain('Где:');
    expect(text.length).toBeLessThan(1000);
  });

  it('environment достаётся и из объектной формы тегов', () => {
    const { text } = formatSentryAlertMessage({
      data: { event: { title: 'boom', tags: [{ key: 'environment', value: 'dev' }] } },
    });

    expect(text).toContain('Окружение: dev');
  });

  it('null и пустые строки трактуются как «значения нет», а не печатаются', () => {
    const { text, degraded } = formatSentryAlertMessage({
      data: { event: { title: null, message: '', culprit: 'GET /api/bot', level: null } },
    });

    expect(degraded).toBe(false);
    expect(text).toContain('Sentry · ОШИБКА'); // level=null → дефолт error
    expect(text).toContain('GET /api/bot');
    expect(text).not.toContain('Окружение');
  });

  it('обрезает слишком длинный title', () => {
    const { text } = formatSentryAlertMessage({ event: { title: 'x'.repeat(500) } });

    expect(text).toContain('…');
    expect(text.length).toBeLessThan(500);
  });
});
