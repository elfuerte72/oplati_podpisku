import { ilike, or, sql, type SQL } from 'drizzle-orm';

import { users } from '../schema.ts';

/**
 * «Найти клиента по тексту» — ОДНО условие на быстрый поиск ⌘K и список
 * клиентов (ревью 2026-09-14: второе определение уже разошлось на `@username`
 * в том же diff'е, где появилось).
 *
 * Ищет по имени, telegram_id, `@username`, почте и цифрам телефона. Телефон —
 * по цифрам с обеих сторон: в базе он `+7999…`, а спрашивают с восьмёркой,
 * скобками и кусками; меньше четырёх цифр — перебор половины базы, а не
 * поиск. Колонки — ссылки Drizzle, поэтому фрагмент годится и builder'у
 * (`.where(...)`), и raw-`sql` с `FROM users` без алиаса.
 */

/**
 * Потолок длины поискового запроса — общий для базы и экранов. Без него
 * строка любой длины гоняет несколько ILIKE с ведущим `%` в том же процессе,
 * что принимает вебхуки; экран режет ввод тем же числом, иначе обрезка на
 * экране и в базе разъезжались бы.
 */
export const PANEL_SEARCH_QUERY_MAX_LENGTH = 100;

/**
 * Экранирование спецсимволов LIKE. Без него оператор, ищущий `100%` или
 * `ivan_petrov@…`, получает подстановочный знак вместо литерала и недоумевает,
 * почему выдача не та. Инъекции здесь нет (параметр связан), это корректность.
 * Обратный слэш — экранирующий символ LIKE по умолчанию в Postgres.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Запрос после обрезки и trim; пустая строка — искать нечего. */
export function normalizeSearchQuery(raw: string | undefined): string {
  return (raw ?? '').trim().slice(0, PANEL_SEARCH_QUERY_MAX_LENGTH);
}

/**
 * Условие поиска клиента или `null`, если искать нечего (пустой запрос).
 * Вызывающий решает, что значит «нечего»: список показывает всех, быстрый
 * поиск не ходит в базу вовсе.
 */
export function clientSearchCondition(query: string): SQL | null {
  const normalized = normalizeSearchQuery(query);
  if (normalized === '') return null;

  const like = `%${escapeLikePattern(normalized)}%`;
  const alternatives: SQL[] = [
    ilike(users.displayName, like),
    ilike(users.telegramId, like),
    ilike(users.telegramUsername, like),
    ilike(users.email, like),
  ];
  const digits = normalized.replace(/\D/g, '');
  if (digits.length >= 4) {
    alternatives.push(
      sql`regexp_replace(${users.phone}, '\\D', '', 'g') LIKE ${`%${digits}%`}`,
    );
  }
  // `or` отдаёт `SQL | undefined`; при непустом списке undefined невозможен.
  return or(...alternatives) ?? null;
}
