import { createHash } from 'node:crypto';

/**
 * Отпечаток тела поста. Считается ТОЛЬКО здесь и только из тела: оценка
 * редактора и решение владельца относятся к конкретным словам, а не к id поста.
 *
 * Почему это не поле, которое заполняет вызывающий: тогда правка тела без
 * обновления отпечатка сохраняет право на публикацию, и в канал уходит текст,
 * которого владелец не видел (находка ревью тикета 02). Отпечаток — производное
 * тела, и считает его хранилище на записи.
 */
export function textShaOf(body: string): string {
  return createHash('sha256').update(body.trim(), 'utf8').digest('hex').slice(0, 16);
}

/** Длина префикса в `callback_data`: кнопка обязана уложиться в 64 байта. */
export const SHA8_LENGTH = 8;

/** Префикс отпечатка для кнопки. */
export function sha8Of(textSha: string): string {
  return textSha.slice(0, SHA8_LENGTH);
}

/**
 * Относится ли нажатая кнопка к текущему тексту поста.
 *
 * Сравнение по префиксу — свойство транспорта: в `callback_data` влезает восемь
 * знаков. В журнал решений пишется ПОЛНЫЙ отпечаток поста, поэтому гейт
 * публикации остаётся строгим.
 */
export function matchesSha8(textSha: string | undefined, sha8: string): boolean {
  if (textSha === undefined || textSha === '') return false;
  if (sha8.length !== SHA8_LENGTH) return false;
  return sha8Of(textSha) === sha8;
}
