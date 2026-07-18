import { describe, expect, it } from 'vitest';

import { formatRub } from '@/components/comic/format';

import { buildPaymentIssueOperatorMessage } from './templates';

describe('buildPaymentIssueOperatorMessage', () => {
  const base = {
    telegramId: '379336096',
    displayName: 'Иван Петров',
    orderShortId: 'ORD-7KX42',
    service: 'ChatGPT',
    tierName: 'Plus',
    amountKopecks: 249_000,
    cardStatusLabel: 'Активна',
    issueType: 'card_declined' as const,
  };

  it('передаёт весь контекст: заказ, сервис, тариф, сумму, статус карты, тип ошибки', () => {
    const msg = buildPaymentIssueOperatorMessage(base);
    expect(msg).toContain('ORD-7KX42');
    expect(msg).toContain('ChatGPT');
    expect(msg).toContain('Plus');
    expect(msg).toContain(formatRub(249_000));
    expect(msg).toContain('Активна');
    expect(msg).toContain('Карта отклоняется при оплате');
    expect(msg).toContain('<code>379336096</code>');
    expect(msg).toContain('tg://user?id=379336096');
  });

  it('опциональные поля опускаются без пустых строк-ярлыков', () => {
    const msg = buildPaymentIssueOperatorMessage({
      telegramId: '1',
      orderShortId: 'ORD-1',
      service: 'Заказ вне каталога',
      issueType: 'other',
    });
    expect(msg).not.toContain('Тариф:');
    expect(msg).not.toContain('Статус карты:');
    expect(msg).not.toContain('Комментарий клиента:');
    expect(msg).toContain('без имени');
  });

  it('экранирует HTML в пользовательских полях (имя, комментарий, сервис)', () => {
    const msg = buildPaymentIssueOperatorMessage({
      ...base,
      displayName: '<b>Хакер</b>',
      service: 'Chat<GPT>',
      comment: '<script>alert(1)</script> & прочее',
    });
    expect(msg).not.toContain('<b>Хакер</b>');
    expect(msg).not.toContain('<script>');
    expect(msg).toContain('&lt;b&gt;Хакер&lt;/b&gt;');
    expect(msg).toContain('Chat&lt;GPT&gt;');
    expect(msg).toContain('&amp; прочее');
  });

  it('длинный комментарий обрезается — сообщение помещается в лимит Telegram', () => {
    const msg = buildPaymentIssueOperatorMessage({
      ...base,
      comment: 'ы'.repeat(10_000),
    });
    expect(msg.length).toBeLessThanOrEqual(4096);
    expect(msg).toContain('…');
  });

  it('комментарий из «&» не раздувается экранированием за лимит', () => {
    const msg = buildPaymentIssueOperatorMessage({
      ...base,
      comment: '&'.repeat(4000),
    });
    expect(msg.length).toBeLessThanOrEqual(4096);
    // не рвём HTML-сущность на границе обрезки
    expect(/&(?:[a-z]+)?$/.test(msg.replace(/…$/, ''))).toBe(false);
  });
});
