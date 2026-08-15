import { describe, expect, it } from 'vitest';

import { redactPaths } from '../logger.ts';
import { beforeSend, type SentryEvent } from '../sentry.ts';

/**
 * Канарейка антифрод-трека (Р5): контакты и адрес клиента читаемы для
 * провайдера, но НИКОГДА не уходят в логи/Sentry — режим PAN. Сужение списка
 * должно ронять тест, а не выясняться в проде по логам.
 */
describe('redact контактов плательщика (тикеты 01/02, Р5)', () => {
  it('pino: email/phone/tel/last_seen_ip в денилисте', () => {
    expect(redactPaths).toContain('*.email');
    expect(redactPaths).toContain('*.phone');
    expect(redactPaths).toContain('*.tel');
    expect(redactPaths).toContain('*.last_seen_ip');
    expect(redactPaths).toContain('*.lastSeenIp');
  });

  it('Sentry beforeSend вычищает tel и last_seen_ip из extra', () => {
    const out = beforeSend({
      extra: {
        tel: '+79991234567',
        last_seen_ip: '203.0.113.5',
        lastSeenIp: '203.0.113.5',
        email: 'client@example.com',
        orderId: 'ord-1',
      },
    } as unknown as SentryEvent);

    expect(out?.extra).toMatchObject({
      tel: '[REDACTED]',
      last_seen_ip: '[REDACTED]',
      lastSeenIp: '[REDACTED]',
      email: '[REDACTED]',
      orderId: 'ord-1',
    });
  });
});
