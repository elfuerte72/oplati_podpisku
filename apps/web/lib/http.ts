import type { ZodType } from 'zod';

/**
 * Клиентские HTTP-хелперы для чат-UI.
 *
 * Правило проекта: `fetch` без таймаута запрещён — иначе зависший запрос держит
 * спиннер/поллинг бесконечно. `fetchWithTimeout` оборачивает fetch в
 * AbortController; при истечении таймаута бросает AbortError, который caller
 * ловит как обычную сетевую ошибку.
 *
 * `parseJsonSafe` валидирует тело ответа Zod-схемой вместо `as T` — не доверяем
 * форме ответа слепо (Zod на границах). Возвращает `null` при невалидном
 * JSON/форме; caller решает, что показать.
 */

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * То же, но таймаут держится и на ЧТЕНИИ ТЕЛА.
 *
 * `fetchWithTimeout` отдаёт `Response` и снимает таймер — тело после этого
 * читается без всякого срока. В браузере это терпимо (вкладку закроют), а на
 * сервере смертельно: ответ с заголовками и молчащим телом вешает вызывающий
 * код навсегда (аудит 2026-08-10, ревью 2026-08-11). Серверный код обязан
 * использовать этот вариант; он же сразу валидирует форму (Zod на границах).
 *
 * Бюджет один на весь запрос вместе с телом: помощник применяется там, где
 * ответы маленькие и время ответа неважно, — второй таймер только запутал бы.
 */
export async function fetchJsonWithTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  schema: ZodType<T>,
  timeoutMs = 10_000,
): Promise<T | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      // Обрыв по таймауту НЕ приравниваем к «пришёл не JSON»: caller должен
      // отличать медленный/мёртвый сервис от кривого ответа, иначе тишина
      // выглядит как штатная деградация («never swallow errors»).
      if (err instanceof Error && err.name === 'AbortError') throw err;
      return null;
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function parseJsonSafe<T>(res: Response, schema: ZodType<T>): Promise<T | null> {
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
