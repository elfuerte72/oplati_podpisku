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

  it('редактирует поиск панели: ?q= несёт контакт клиента', () => {
    const out = beforeSend({
      request: { query_string: 'q=ivan%40example.com&s2=1' },
    } as never);

    expect(out?.request?.query_string).toBe('q=[REDACTED]&s2=1');
  });

  it('чистит строку запроса и в request.url — она несёт те же параметры', () => {
    // Раньше денилист стоял только на `query_string`, а `url` уезжал целиком:
    // обход был бесплатным и незаметным.
    const out = beforeSend({
      request: {
        url: 'https://admin.oplatishka.com/admin/orders?q=ivan%40example.com&s=live',
        query_string: 'q=ivan%40example.com&s=live',
      },
    } as never);

    expect(out?.request?.url).toBe(
      'https://admin.oplatishka.com/admin/orders?q=[REDACTED]&s=[REDACTED]',
    );
    expect(JSON.stringify(out)).not.toContain('ivan');
  });

  it('url без строки запроса не портится', () => {
    const out = beforeSend({
      request: { url: 'https://admin.oplatishka.com/admin/orders' },
    } as never);

    expect(out?.request?.url).toBe('https://admin.oplatishka.com/admin/orders');
  });

  it('параметры, лишь СОДЕРЖАЩИЕ q, не задеваются', () => {
    const out = beforeSend({
      request: { query_string: 'seq=7&uniq=abc' },
    } as never);

    expect(out?.request?.query_string).toBe('seq=7&uniq=abc');
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

/**
 * `contexts` и `tags` тоже скрабятся (аудит 2026-08-10, LOW): комментарий
 * функции обещал «Extra / contexts», а код чистил только `extra`. Контекст
 * Sentry заполняется не только нами — SDK и интеграции складывают туда свои
 * структуры, поэтому денилист обязан покрывать и его.
 */
describe('beforeSend: contexts и tags', () => {
  it('РЕГРЕСС: pan/cvc внутри contexts редактируются', () => {
    const event = beforeSend({
      contexts: {
        order: { pan: '4111111111111111', cvc: '123', amount: 2490 },
      },
    } as unknown as SentryEvent) as unknown as {
      contexts: { order: Record<string, unknown> };
    };

    expect(event.contexts.order.pan).toBe('[REDACTED]');
    expect(event.contexts.order.cvc).toBe('[REDACTED]');
    expect(event.contexts.order.amount).toBe(2490);
  });

  it('РЕГРЕСС: секрет в tags редактируется', () => {
    const event = beforeSend({
      tags: { token: 'secret-token', source: 'cron.poll-payment' },
    } as unknown as SentryEvent) as unknown as { tags: Record<string, unknown> };

    expect(event.tags.token).toBe('[REDACTED]');
    expect(event.tags.source).toBe('cron.poll-payment');
  });
});

/**
 * Свободный текст события — единственный канал, который денилист по ключам не
 * закрывает, а именно туда клиенты шлюзов кладут сырое тело ответа
 * (`message: respText.slice(0, 500)`). Находка ревью 2026-08-11.
 */
describe('beforeSend: свободный текст message и exception', () => {
  it('РЕГРЕСС: PAN в тексте исключения маскируется', () => {
    const event = beforeSend({
      exception: {
        values: [{ type: 'FreekassaContractError', value: 'drift: {"pan":"4111 1111 1111 1111"}' }],
      },
    } as unknown as SentryEvent) as unknown as {
      exception: { values: { value: string }[] };
    };

    const text = event.exception.values[0]?.value ?? '';
    expect(text).not.toContain('4111 1111 1111 1111');
    expect(text).toContain('**** 1111');
  });

  it('РЕГРЕСС: PAN и Bearer-токен в message маскируются', () => {
    const event = beforeSend({
      message: 'gateway said 5592680100101726, auth Bearer abc.def-123',
    } as unknown as SentryEvent) as unknown as { message: string };

    expect(event.message).not.toContain('5592680100101726');
    expect(event.message).toContain('**** 1726');
    expect(event.message).toContain('Bearer [REDACTED]');
  });
});
