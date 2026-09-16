import { z } from 'zod';

/**
 * Контракт API кошелька FKWallet.io — единственного места, куда касса Freekassa
 * умеет выводить деньги (см. `freekassa.ts`, `FREEKASSA_WITHDRAWAL_METHODS`).
 *
 * Снят из OpenAPI-схемы `https://fkwallet.io/openapi-scheme-en.json`
 * 2026-09-16 (страница доки рендерится скриптом `rapi-doc`, схема лежит рядом).
 *
 * Формат:
 *  - база `https://api.fkwallet.io/v1/{public_key}/…`;
 *  - авторизация — `Authorization: Bearer <sha256-hex(JSON тела + приватный ключ)>`,
 *    у GET без тела — `sha256-hex(приватный ключ)`;
 *  - ответ `{ status: 'ok', data }`; форма ошибки в схеме не описана — любой
 *    ответ со `status`, отличным от `ok`, считаем отказом.
 *
 * ⚠️ Живым вызовом контракт пока НЕ подтверждён (ключи заводит владелец). Схема
 * кошелька написана небрежно: у баланса `data` описан ОБЪЕКТОМ там, где по
 * смыслу список, а сам ответ — то с обёрткой `{ data: { status, data } }`, то
 * без. Zod принимает все варианты; первый живой вызов обязан зафиксировать
 * факт здесь же и сузить схему.
 */

export const FKWALLET_API_BASE_URL = 'https://api.fkwallet.io/v1';

/** Число в ответах кошелька — наружу строкой, как у Freekassa и PaySpace. */
const fkWalletNumeric = z.union([z.number(), z.string().min(1)]).transform((v) => String(v));

/**
 * Снимает лишнюю обёртку: схема описывает `{ data: { status, data } }`, PHP-пример
 * в той же доке читает `status` с верхнего уровня. Берём тот уровень, где
 * лежит `status`.
 */
function unwrapEnvelope(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  if ('status' in obj) return obj;
  const inner = obj.data;
  if (typeof inner === 'object' && inner !== null && 'status' in (inner as object)) return inner;
  return raw;
}

/** Остаток по одной валюте: `currency_code` — `RUB`, `USDT`, `USD`, … */
export const fkWalletBalanceEntrySchema = z.object({
  currency_code: z.string().min(1),
  value: fkWalletNumeric,
});
export type FkWalletBalanceEntry = z.infer<typeof fkWalletBalanceEntrySchema>;

export const fkWalletBalanceResponseSchema = z.preprocess(
  unwrapEnvelope,
  z.object({
    status: z.literal('ok'),
    data: z
      .union([z.array(fkWalletBalanceEntrySchema), fkWalletBalanceEntrySchema])
      .transform((d) => (Array.isArray(d) ? d : [d])),
  }),
);
export type FkWalletBalanceResponse = z.infer<typeof fkWalletBalanceResponseSchema>;

/**
 * Отказ провайдера. Текст берём из любого из полей, которые кошелёк мог бы
 * прислать: форма ошибки докой не описана.
 */
export const fkWalletErrorResponseSchema = z.preprocess(
  unwrapEnvelope,
  z.object({
    status: z.string().refine((s) => s !== 'ok', { message: 'status ok is not an error' }),
    message: z.string().optional(),
    desc: z.string().optional(),
    error: z.string().optional(),
  }),
);
export type FkWalletErrorResponse = z.infer<typeof fkWalletErrorResponseSchema>;
