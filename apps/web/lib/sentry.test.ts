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
    expect(ctx.initData).toBe('[REDACTED]');
    expect(ctx.init_data).toBe('[REDACTED]');
    expect(ctx.signature).toBe('[REDACTED]');
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
});
