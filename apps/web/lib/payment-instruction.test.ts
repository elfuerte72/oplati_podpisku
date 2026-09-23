import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('страница «Как оплатить»', () => {
  it('направляет клиента в веб-версию сервиса по кнопке под сообщением с картой', () => {
    const html = readFileSync(new URL('../public/payment-instruction.html', import.meta.url), 'utf8');

    expect(html).toContain('в веб-версии сервиса');
    expect(html).toContain('не в мобильном приложении');
    // Кнопка под сообщением с картой — «Открыть <сервис>» (issue-card); кнопки
    // «Открыть прайс сервиса» больше нет, и страница не должна её называть.
    expect(html).toContain('с названием сервиса под сообщением с картой');
    expect(html).not.toContain('Открыть прайс сервиса');
  });

  it('не называет страну выпуска карты и не зовёт писать в чат бота', () => {
    // Разбор пути клиента 2026-09-23: «карта США» нарушала правило ТЗ §2, а
    // «вернись в бот и напиши нам» — бот на свободный текст не отвечает.
    const html = readFileSync(new URL('../public/payment-instruction.html', import.meta.url), 'utf8');

    expect(html).not.toMatch(/карт[а-яё]*\s+США/i);
    expect(html).not.toContain('вернись в бот и напиши');
  });

  it('использует рабочий telegram.me для Mini App и fallback на бота', () => {
    const html = readFileSync(new URL('../public/payment-instruction.html', import.meta.url), 'utf8');

    expect(html).toContain('https://telegram.me/oplatishkaa_bot/oplatishkaMiniApp');
    expect(html).toContain('https://telegram.me/oplatishkaa_bot?start=app');
    expect(html).not.toContain('https://t.me/');
  });
});
