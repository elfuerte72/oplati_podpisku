import { describe, expect, it } from 'vitest';

import { formatRub } from '@/components/comic/format';

import { buildOrderExpiredMessage, paymentRulesHtml } from './templates';

describe('paymentRulesHtml', () => {
  it('напоминает оплачивать в веб-версии сервиса, а не в мобильном приложении', () => {
    const html = paymentRulesHtml(2000);

    expect(html).toContain('в веб-версии сервиса');
    expect(html).toContain('не в мобильном приложении');
  });
});

describe('buildOrderExpiredMessage', () => {
  // 00:30 UTC = 03:30 по Москве → дата «19 июля» (проверяем и таймзону).
  const createdAt = new Date('2026-07-19T00:30:00.000Z');

  it('называет сервис, сумму и дату оформления вместо номера заказа', () => {
    const text = buildOrderExpiredMessage({
      serviceLabel: 'ChatGPT Plus',
      amountKopecks: 245_640,
      createdAt,
    });

    expect(text).toContain('ChatGPT Plus');
    // Разделители тысяч у Intl — неразрывные пробелы: сверяем с самим formatRub.
    expect(text).toContain(formatRub(245_640));
    expect(text).toContain('19 июля');
    expect(text).toContain('/start');
    expect(text).not.toContain('ORD-');
  });

  it('без названия сервиса → нейтральный «заказ», текст не ломается', () => {
    const text = buildOrderExpiredMessage({
      serviceLabel: null,
      amountKopecks: 100_000,
      createdAt,
    });

    expect(text).toContain('заказ');
    expect(text).toContain(formatRub(100_000));
    expect(text).toContain('19 июля');
  });

  it('без суммы → сумма опускается, дата и призыв остаются', () => {
    const text = buildOrderExpiredMessage({
      serviceLabel: 'Spotify Premium',
      amountKopecks: null,
      createdAt,
    });

    expect(text).toContain('Spotify Premium');
    expect(text).not.toContain('₽');
    expect(text).toContain('19 июля');
    expect(text).toContain('/start');
  });
});
