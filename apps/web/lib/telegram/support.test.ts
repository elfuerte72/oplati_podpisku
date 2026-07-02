import { describe, expect, it } from 'vitest';

import { buildSupportOperatorMessage, SUPPORT_MESSAGE_MAX_LEN } from './templates';

describe('buildSupportOperatorMessage', () => {
  it('включает имя, @username, id, tg-ссылку и текст', () => {
    const msg = buildSupportOperatorMessage({
      telegramId: 379336096,
      firstName: 'Иван',
      lastName: 'Петров',
      username: 'ivan',
      description: 'Не приходит ссылка на оплату',
    });
    expect(msg).toContain('Иван Петров');
    expect(msg).toContain('@ivan');
    expect(msg).toContain('<code>379336096</code>');
    expect(msg).toContain('tg://user?id=379336096');
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
});
