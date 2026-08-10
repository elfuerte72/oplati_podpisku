import { describe, expect, it } from 'vitest';

import { formatRub } from '@/components/comic/format';

import { buildPaymentIssueOperatorMessage, redactCardNumbers } from './templates';

describe('buildPaymentIssueOperatorMessage', () => {
  const base = {
    telegramId: '111222333',
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
    expect(msg).toContain('<code>111222333</code>');
    expect(msg).toContain('tg://user?id=111222333');
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

  it('PAN-подобные последовательности в комментарии маскируются (политика PII)', () => {
    const msg = buildPaymentIssueOperatorMessage({
      ...base,
      comment: 'ввожу 4242 4242 4242 4242 и не проходит',
    });
    expect(msg).not.toContain('4242 4242 4242 4242');
    expect(msg).toContain('**** 4242');
  });

  it('redactCardNumbers: любые разделители, отсев по Луну, длина 16 всегда', () => {
    // Ревью 2026-08-11: точки/слэши/переводы строк — обычный способ вставить
    // номер, а «12+ цифр подряд» съедало даты и референсы СБП.
    expect(redactCardNumbers('карта 5592.6801.0010.1726 не проходит')).toBe(
      'карта **** 1726 не проходит',
    );
    expect(redactCardNumbers('5592/6801/0010/1726')).toBe('**** 1726');
    // Дата+время (14 цифр, Луна не проходит) остаётся оператору как есть.
    expect(redactCardNumbers('оплатил 10 08 2026 12 30 45 не прошло')).toBe(
      'оплатил 10 08 2026 12 30 45 не прошло',
    );
    // Валидный по Луну 13-значный PAN тоже маскируется.
    expect(redactCardNumbers('4222222222222')).toBe('**** 2222');
  });

  it('redactCardNumbers: маскирует 12–19 цифр с разделителями, не трогает телефон/суммы', () => {
    expect(redactCardNumbers('карта 5592-6801-0010-1726, ок?')).toBe('карта **** 1726, ок?');
    expect(redactCardNumbers('позвоните +7 999 123-45-67')).toBe('позвоните +7 999 123-45-67');
    expect(redactCardNumbers('списалось 2490 руб')).toBe('списалось 2490 руб');
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
