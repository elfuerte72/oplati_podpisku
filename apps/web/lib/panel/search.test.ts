import { describe, expect, it } from 'vitest';

import { PANEL_SEARCH_MIN_LENGTH, clientHitHint, clientHitTitle, isSearchable } from './search';

/**
 * Быстрый поиск (панель v3): решения «идти ли в базу» и «как назвать
 * найденного». Второе важнее, чем кажется: у клиента может не быть ни имени,
 * ни Telegram, а строка выдачи обязана оставаться нажимаемой.
 */
describe('isSearchable', () => {
  it('один символ в базу не ходит', () => {
    expect(isSearchable('а')).toBe(false);
    expect(isSearchable(' ')).toBe(false);
    expect(isSearchable('')).toBe(false);
  });

  it('от двух символов — ищем', () => {
    expect('ан'.length).toBe(PANEL_SEARCH_MIN_LENGTH);
    expect(isSearchable('ан')).toBe(true);
    expect(isSearchable('  ORD-WX7S4  ')).toBe(true);
  });

  it('пробелы не считаются за символы запроса', () => {
    expect(isSearchable(' а ')).toBe(false);
  });
});

describe('clientHitTitle', () => {
  const base = { id: 'u1', displayName: null, telegramId: null, email: null };

  it('имя — первое, что узнаёт человек', () => {
    expect(clientHitTitle({ ...base, displayName: 'Алинка', telegramId: '77', email: 'a@b.c' })).toBe(
      'Алинка',
    );
  });

  it('без имени опознаём по telegram, потом по почте', () => {
    expect(clientHitTitle({ ...base, telegramId: '77', email: 'a@b.c' })).toBe('77');
    expect(clientHitTitle({ ...base, email: 'a@b.c' })).toBe('a@b.c');
  });

  it('пустое имя — это отсутствие имени, а не заголовок из пробелов', () => {
    // Невидимая ссылка не нажимается: строка выдачи обязана иметь текст.
    expect(clientHitTitle({ ...base, displayName: '   ', telegramId: '77' })).toBe('77');
    expect(clientHitTitle(base)).toBe('Клиент без имени');
  });
});

describe('clientHitHint', () => {
  const base = { id: 'u1', displayName: 'Алинка', telegramId: null, email: null };

  it('подсказка отличает соседние строки выдачи', () => {
    expect(clientHitHint({ ...base, telegramId: '77', email: 'a@b.c' })).toBe('77 · a@b.c');
  });

  it('не повторяет заголовок', () => {
    // У клиента без имени заголовком стал telegram — во второй строке он был
    // бы тем же текстом дважды.
    expect(clientHitHint({ ...base, displayName: null, telegramId: '77' })).toBe('без Telegram');
    expect(clientHitHint({ ...base, displayName: null, telegramId: '77', email: 'a@b.c' })).toBe(
      'a@b.c',
    );
  });

  it('клиенту без контактов пишем, что их нет', () => {
    expect(clientHitHint(base)).toBe('без Telegram');
  });
});
