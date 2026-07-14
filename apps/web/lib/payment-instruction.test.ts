import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('страница «Как оплатить»', () => {
  it('направляет клиента в веб-версию сервиса по кнопке прайса', () => {
    const html = readFileSync(new URL('../public/payment-instruction.html', import.meta.url), 'utf8');

    expect(html).toContain('в веб-версии сервиса');
    expect(html).toContain('не в мобильном приложении');
    expect(html).toContain('Открыть прайс сервиса');
  });

  it('использует рабочий telegram.me для Mini App и fallback на бота', () => {
    const html = readFileSync(new URL('../public/payment-instruction.html', import.meta.url), 'utf8');

    expect(html).toContain('https://telegram.me/oplatishkaa_bot/oplatishkaMiniApp');
    expect(html).toContain('https://telegram.me/oplatishkaa_bot?start=app');
    expect(html).not.toContain('https://t.me/');
  });
});
