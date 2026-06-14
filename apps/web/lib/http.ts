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
