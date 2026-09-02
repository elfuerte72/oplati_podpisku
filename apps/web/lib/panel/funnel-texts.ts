import 'server-only';

import { listFunnelTextOverrides, type DB } from '@oplati/db';

import {
  funnelTextSpec,
  validateFunnelText,
  type FunnelTextSpec,
  type FunnelTextValidation,
} from '@/lib/funnel/texts';

/**
 * Общее для операций панели над текстами воронки (тикеты 11–12): разбор ключа
 * и валидация с учётом уже сохранённых соседей. Одна функция на «сохранить» и
 * «отправить мне» — невалидный текст не уходит ни в базу, ни в Telegram.
 */

export type FunnelTextCheck =
  | { ok: true; spec: FunnelTextSpec; value: string }
  | { ok: false; status: 400 | 422; error: string; placeholder?: string; max?: number };

export async function checkFunnelTextForKey(
  db: DB,
  key: string,
  rawValue: string,
): Promise<FunnelTextCheck> {
  const spec = funnelTextSpec(key);
  if (!spec) return { ok: false, status: 400, error: 'unknown_key' };

  // Уникальность подписей ответов считается по ТЕКУЩИМ значениям соседей —
  // с учётом их переопределений, а не только дефолтов.
  const overrides = await listFunnelTextOverrides(db);
  const siblings: Record<string, string> = {};
  for (const row of overrides) siblings[row.key] = row.value;

  return toCheck(spec, validateFunnelText(spec, rawValue, siblings));
}

function toCheck(spec: FunnelTextSpec, v: FunnelTextValidation): FunnelTextCheck {
  if (v.ok) return { ok: true, spec, value: v.value };
  switch (v.reason) {
    case 'missing_placeholder':
    case 'unknown_placeholder':
      return { ok: false, status: 422, error: v.reason, placeholder: v.placeholder };
    case 'too_long':
      return { ok: false, status: 422, error: v.reason, max: v.max };
    default:
      return { ok: false, status: 422, error: v.reason };
  }
}

/** Тело отказа операции — единый формат для клиента. */
export function funnelTextErrorResponse(check: Extract<FunnelTextCheck, { ok: false }>): Response {
  const { status, ...body } = check;
  return Response.json(body, { status });
}
