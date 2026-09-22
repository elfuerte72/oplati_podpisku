import { createHash } from 'node:crypto';

/**
 * Данные кнопки: `ns:action:id:sha8`, не длиннее 64 байт (лимит Bot API).
 *
 * `sha8` — отпечаток того, что владелец видел на момент показа кнопок: текста
 * поста или самого вопроса. Нажатие с чужим отпечатком означает клик по
 * старому сообщению, и такая кнопка не работает — иначе «Опубликовать» из
 * сообщения недельной давности отправило бы в канал переписанный с тех пор
 * текст.
 */

export const CALLBACK_NS = 'p';
export const CALLBACK_MAX_BYTES = 64;
export const STAMP_LENGTH = 8;

export interface CallbackData {
  readonly action: string;
  readonly id: string;
  readonly stamp: string;
}

export function buildCallback(action: string, id: string, stamp: string): string {
  const data = `${CALLBACK_NS}:${action}:${id}:${stamp}`;
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_MAX_BYTES) {
    // Это ошибка кода: длинное действие или длинный id не влезут в кнопку, и
    // Telegram отвергнет всю клавиатуру.
    throw new Error(`данные кнопки длиннее ${CALLBACK_MAX_BYTES} байт: ${data}`);
  }
  return data;
}

export function parseCallback(data: string): CallbackData | undefined {
  const parts = data.split(':');
  if (parts.length !== 4) return undefined;
  const [ns, action, id, stamp] = parts;
  if (ns !== CALLBACK_NS) return undefined;
  if (action === undefined || action === '' || id === undefined || stamp === undefined) {
    return undefined;
  }
  return { action, id, stamp };
}

/**
 * Отпечаток показанного. Для превью это тело поста, для вопроса — сам вопрос
 * вместе с вариантами: сменились варианты — старые кнопки перестают работать.
 */
export function stampOf(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return createHash('sha256').update(text).digest('hex').slice(0, STAMP_LENGTH);
}
