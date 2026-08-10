import { describe, expect, it } from 'vitest';

import { buildSupportOperatorMessage, SUPPORT_MESSAGE_MAX_LEN } from './templates';

describe('buildSupportOperatorMessage', () => {
  it('включает имя, @username, id, tg-ссылку и текст', () => {
    const msg = buildSupportOperatorMessage({
      telegramId: 111222333,
      firstName: 'Иван',
      lastName: 'Петров',
      username: 'ivan',
      description: 'Не приходит ссылка на оплату',
    });
    expect(msg).toContain('Иван Петров');
    expect(msg).toContain('@ivan');
    expect(msg).toContain('<code>111222333</code>');
    expect(msg).toContain('tg://user?id=111222333');
    expect(msg).toContain('Не приходит ссылка на оплату');
  });

  it('экранирует HTML-спецсимволы в имени и описании', () => {
    const msg = buildSupportOperatorMessage({
      telegramId: 1,
      firstName: '<b>Хакер</b>',
      description: 'проблема с <script>alert(1)</script> & прочим',
    });
    // Пользовательский ввод не должен ломать разметку/инъектить теги.
    expect(msg).not.toContain('<b>Хакер</b>');
    expect(msg).not.toContain('<script>');
    expect(msg).toContain('&lt;b&gt;Хакер&lt;/b&gt;');
    expect(msg).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; прочим');
  });

  it('подставляет «без имени» и «—» при отсутствии полей', () => {
    const msg = buildSupportOperatorMessage({ telegramId: 42, description: 'помогите' });
    expect(msg).toContain('без имени');
    expect(msg).toMatch(/Username:<\/b>\s—/);
  });

  it('обрезает слишком длинное описание до лимита', () => {
    const long = 'a'.repeat(SUPPORT_MESSAGE_MAX_LEN + 500);
    const msg = buildSupportOperatorMessage({ telegramId: 7, description: long });
    // Тело урезано и помечено многоточием; общая длина остаётся в пределах Telegram.
    expect(msg).toContain('…');
    expect(msg).not.toContain('a'.repeat(SUPPORT_MESSAGE_MAX_LEN + 1));
    expect(msg.length).toBeLessThan(4096);
  });

  it('не превышает лимит Telegram после экранирования (раздувание & → &amp;)', () => {
    // «&» раздувается в 5× при escape — обрезка ДО escape роняла бы sendMessage.
    const msg = buildSupportOperatorMessage({ telegramId: 7, description: '&'.repeat(4000) });
    expect(msg.length).toBeLessThanOrEqual(4096);
    expect(msg.endsWith('…')).toBe(true);
    // Тело не должно содержать «поломанную» сущность (одиночный & без ;).
    const body = msg.slice(msg.indexOf('<b>Сообщение:</b>\n') + '<b>Сообщение:</b>\n'.length);
    expect(body.replace(/&amp;/g, '').replace(/…$/, '')).not.toContain('&');
  });
});

/**
 * Канарейка PAN (аудит 2026-08-10): клиент, у которого «не проходит оплата»,
 * пишет номер карты в поддержку так же охотно, как в форму «Не проходит
 * оплата?». Тот путь маскировал, этот — нет.
 */
describe('buildSupportOperatorMessage — маскирование PAN', () => {
  it('РЕГРЕСС: полный номер карты не доходит до оператора', () => {
    const msg = buildSupportOperatorMessage({
      telegramId: 379000111,
      description: 'моя карта 5592 6801 0010 1726 не проходит',
    });

    expect(msg).not.toContain('5592 6801 0010 1726');
    expect(msg).not.toContain('5592680100101726');
    expect(msg).toContain('**** 1726');
  });

  it('телефон и суммы не трогаются', () => {
    const msg = buildSupportOperatorMessage({
      telegramId: 379000111,
      description: 'списалось 2490 руб, звоните +7 999 123-45-67',
    });

    expect(msg).toContain('2490');
    expect(msg).toContain('+7 999 123-45-67');
  });
});
