import { describe, expect, it } from 'vitest';

import { beforeSend, type SentryEvent } from './sentry.ts';

/**
 * Canary-тесты PII-скраббера (аудит 2026-07-11 F-06): фиксируют, что карточные
 * реквизиты и auth-строки НЕ уезжают в Sentry ни под одним из известных имён
 * полей. Если рефакторинг сломает денилист — упадут эти тесты, а не комплаенс.
 */

function makeEvent(overrides: Partial<SentryEvent>): SentryEvent {
  return { type: undefined, ...overrides } as SentryEvent;
}

describe('beforeSend: карточные реквизиты и секреты', () => {
  it('редактирует pan/cvc/cvv/cardNo/card_no в request.data (все варианты имён)', () => {
    const event = makeEvent({
      request: {
        data: {
          pan: '4111111111111111',
          cvc: '123',
          cvv: '456',
          cardNo: '5555444433332222',
          card_no: '5105105105105100',
          keep: 'ok',
        },
      },
    });

    const out = beforeSend(event);
    const data = out?.request?.data as Record<string, unknown>;
    expect(data.pan).toBe('[REDACTED]');
    expect(data.cvc).toBe('[REDACTED]');
    expect(data.cvv).toBe('[REDACTED]');
    expect(data.cardNo).toBe('[REDACTED]');
    expect(data.card_no).toBe('[REDACTED]');
    expect(data.keep).toBe('ok');
  });

  it('редактирует initData/init_data/signature во вложенных extra', () => {
    const event = makeEvent({
      extra: {
        ctx: {
          initData: 'query_id=AAE...&hash=abc',
          init_data: 'user=...',
          signature: 'deadbeef',
        },
      },
    });

    const out = beforeSend(event);
    const ctx = (out?.extra as Record<string, Record<string, unknown>>).ctx;
    expect(ctx?.initData).toBe('[REDACTED]');
    expect(ctx?.init_data).toBe('[REDACTED]');
    expect(ctx?.signature).toBe('[REDACTED]');
  });

  it('редактирует секрет ?s= в query_string, не задевая другие параметры', () => {
    const event = makeEvent({
      request: { query_string: 's=super-secret&tags=alerts&status=ok' },
    });

    const out = beforeSend(event);
    expect(out?.request?.query_string).toBe('s=[REDACTED]&tags=alerts&status=ok');
  });

  it('редактирует s= в середине query_string по границе параметра', () => {
    const event = makeEvent({
      request: { query_string: 'foo=1&s=secret2&bar=2' },
    });

    const out = beforeSend(event);
    expect(out?.request?.query_string).toBe('foo=1&s=[REDACTED]&bar=2');
  });

  it('редактирует signature и initData в query_string', () => {
    const event = makeEvent({
      request: { query_string: 'signature=abc&initData=xyz' },
    });

    const out = beforeSend(event);
    expect(out?.request?.query_string).toBe('signature=[REDACTED]&initData=[REDACTED]');
  });

  it('breadcrumbs: данные с pan редактируются', () => {
    const event = makeEvent({
      breadcrumbs: [{ data: { pan: '4111111111111111', step: 'issue' } }],
    });

    const out = beforeSend(event);
    const crumb = out?.breadcrumbs?.[0]?.data as Record<string, unknown>;
    expect(crumb.pan).toBe('[REDACTED]');
    expect(crumb.step).toBe('issue');
  });

  it('редактирует заголовки с секретами, включая initData Mini App', () => {
    // `x-telegram-init-data` живёт 24 часа и её достаточно для card-details,
    // то есть для показа PAN+CVC чужой карты. `/api/analytics` возит её
    // заголовком (в отличие от `/api/cabinet`, где она в теле), поэтому без
    // этого имени в денилисте она уезжала бы в Sentry целиком.
    const event = makeEvent({
      request: {
        headers: {
          'x-telegram-init-data': 'query_id=AAA&user=%7B%22id%22%3A1%7D&hash=deadbeef',
          authorization: 'Bearer secret',
          cookie: 'session=uuid',
          'x-alert-token': 'token',
          'content-type': 'application/json',
          'user-agent': 'Mozilla/5.0',
        },
      },
    });

    const out = beforeSend(event);
    const headers = out?.request?.headers as Record<string, string>;
    expect(headers['x-telegram-init-data']).toBe('[REDACTED]');
    expect(headers.authorization).toBe('[REDACTED]');
    expect(headers.cookie).toBe('[REDACTED]');
    expect(headers['x-alert-token']).toBe('[REDACTED]');
    // Безобидные заголовки остаются: скраббер не должен слепить диагностику.
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe('Mozilla/5.0');
  });
});
