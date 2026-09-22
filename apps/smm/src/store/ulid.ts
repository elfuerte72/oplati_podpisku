import { randomFillSync } from 'node:crypto';

/**
 * ULID вместо uuid: 26 знаков, сортируется по времени как строка. Для бота это
 * важнее случайности — черновики в `/queue`, посты и решения показываются по
 * порядку появления, и сортировка по id совпадает с сортировкой по времени без
 * отдельного индекса.
 *
 * Своя реализация, а не зависимость: тридцать строк против ещё одного пакета в
 * образе (зависимости бота закрыты спекой).
 */

// Алфавит Крокфорда: без I, L, O, U — чтобы id нельзя было прочитать неверно.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(ms: number): string {
  let value = ms;
  let out = '';
  for (let i = 0; i < TIME_LEN; i += 1) {
    out = ALPHABET[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function randomChars(): string {
  const bytes = randomFillSync(new Uint8Array(RANDOM_LEN));
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % 32]!;
  return out;
}

let lastMs = -1;
let lastRandom = '';

/** Инкремент случайной части: два id в одну миллисекунду обязаны сохранять порядок. */
function bumpRandom(chars: string): string {
  const digits = [...chars];
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const index = ALPHABET.indexOf(digits[i]!);
    if (index < 31) {
      digits[i] = ALPHABET[index + 1]!;
      return digits.join('');
    }
    digits[i] = ALPHABET[0]!;
  }
  // Переполнение всей случайной части за одну миллисекунду недостижимо
  // практически, но молча возвращать тот же id нельзя: берём новый случайный.
  return randomChars();
}

export function ulid(now: number = Date.now()): string {
  if (now === lastMs) {
    lastRandom = bumpRandom(lastRandom);
  } else {
    lastMs = now;
    lastRandom = randomChars();
  }
  return encodeTime(now) + lastRandom;
}

/** Время создания из id. Нужно тестам и разбору: id несёт метку времени. */
export function ulidTime(id: string): number {
  let value = 0;
  for (const char of id.slice(0, TIME_LEN)) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`не ULID: ${id}`);
    value = value * 32 + index;
  }
  return value;
}
