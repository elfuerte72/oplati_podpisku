'use client';

import { z } from 'zod';

/**
 * Клиент `/api/cabinet`: на каждый запрос шлём `initData` (подпись Telegram) +
 * action. Ответы парсим Zod-схемами (как ChatClient), чтобы не доверять форме
 * данных вслепую. Схемы зеркалят view-типы из `lib/cabinet/types.ts`.
 */

const orderSummarySchema = z.object({
  orderId: z.string(),
  shortId: z.string(),
  status: z.string(),
  statusLabel: z.string(),
  service: z.string(),
  amountKopecks: z.number().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  payable: z.boolean(),
  repeatable: z.boolean(),
});

const cardViewSchema = z.object({
  id: z.string(),
  panMasked: z.string(),
  status: z.string(),
  statusLabel: z.string(),
  balanceUsdCents: z.number(),
  createdAt: z.string(),
});

const cardDetailsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), number: z.string(), exp: z.string(), cvc: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const paymentViewSchema = z.object({
  amountKopecks: z.number(),
  status: z.string(),
  statusLabel: z.string(),
  invoiceNumber: z.string().nullable(),
  createdAt: z.string(),
});

const eventViewSchema = z.object({ label: z.string(), at: z.string() });

const profileSchema = z.object({
  displayName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  telegramLinked: z.boolean(),
  memberSince: z.string(),
  ordersCount: z.number(),
  totalSpentKopecks: z.number(),
});

const snapshotSchema = z.object({
  ok: z.literal(true),
  profile: profileSchema,
  orders: z.array(orderSummarySchema),
  cards: z.array(cardViewSchema),
});

const orderDetailSchema = orderSummarySchema.extend({
  originalAmount: z.number().nullable(),
  originalCurrency: z.string().nullable(),
  commissionPercent: z.number().nullable(),
  paidAt: z.string().nullable(),
  fulfilledAt: z.string().nullable(),
  events: z.array(eventViewSchema),
  payments: z.array(paymentViewSchema),
  card: cardViewSchema.nullable(),
});

const orderDetailResponseSchema = z.object({ ok: z.literal(true), order: orderDetailSchema });

const payResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    paymentUrl: z.string(),
    qrPayload: z.string().nullable(),
    expiresAt: z.string().nullable(),
  }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string() }),
]);

const repeatResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    orderId: z.string(),
    shortId: z.string(),
    service: z.string(),
    totalKopecks: z.number(),
    expiresAt: z.string(),
  }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string() }),
]);

const operatorResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    slaHours: z.number(),
    withinBusinessHours: z.boolean(),
    duplicate: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string() }),
]);

export type OrderSummary = z.infer<typeof orderSummarySchema>;
export type CardView = z.infer<typeof cardViewSchema>;
export type CardDetailsResult = z.infer<typeof cardDetailsResultSchema>;
export type PaymentView = z.infer<typeof paymentViewSchema>;
export type OrderEventView = z.infer<typeof eventViewSchema>;
export type CabinetProfile = z.infer<typeof profileSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type OrderDetail = z.infer<typeof orderDetailSchema>;
export type PayResult = z.infer<typeof payResultSchema>;
export type RepeatResult = z.infer<typeof repeatResultSchema>;
export type OperatorResult = z.infer<typeof operatorResultSchema>;

export type ApiError = { ok: false; status: number; error: string };
export type ApiOk<T> = { ok: true; data: T };
export type ApiResult<T> = ApiOk<T> | ApiError;

const GENERIC_ERROR = 'network_error';

async function callCabinet(body: Record<string, unknown>): Promise<{ status: number; json: unknown } | null> {
  try {
    const res = await fetch('/api/cabinet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch {
    return null;
  }
}

function parseOrError<T>(
  resp: { status: number; json: unknown } | null,
  schema: z.ZodType<T>,
): ApiResult<T> {
  if (!resp) return { ok: false, status: 0, error: GENERIC_ERROR };
  const parsed = schema.safeParse(resp.json);
  if (parsed.success) return { ok: true, data: parsed.data };
  const err =
    resp.json && typeof resp.json === 'object' && 'error' in resp.json
      ? String((resp.json as { error: unknown }).error)
      : GENERIC_ERROR;
  return { ok: false, status: resp.status, error: err };
}

export async function fetchSnapshot(initData: string): Promise<ApiResult<Snapshot>> {
  const resp = await callCabinet({ action: 'snapshot', initData });
  return parseOrError(resp, snapshotSchema);
}

export async function fetchOrderDetail(
  initData: string,
  orderId: string,
): Promise<ApiResult<OrderDetail>> {
  const resp = await callCabinet({ action: 'order', initData, orderId });
  const result = parseOrError(resp, orderDetailResponseSchema);
  return result.ok ? { ok: true, data: result.data.order } : result;
}

/**
 * Разовый показ реквизитов карты (номер/срок/CVC). Сервер тянет их живым
 * запросом из PaySpace и НЕ хранит. Ответ не кэшируется (no-store на роуте).
 */
export async function fetchCardDetails(initData: string, cardId: string): Promise<CardDetailsResult> {
  const resp = await callCabinet({ action: 'card-details', initData, cardId });
  const parsed = resp ? cardDetailsResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) return parsed.data;
  return { ok: false, error: 'network_error' };
}

/** Действия возвращают свой discriminated-результат (ok:true/false) как есть. */
export async function doPay(initData: string, orderId: string): Promise<PayResult> {
  const resp = await callCabinet({ action: 'pay', initData, orderId });
  const parsed = resp ? payResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) return parsed.data;
  return { ok: false, error: GENERIC_ERROR, message: 'Сеть недоступна. Попробуй ещё раз.' };
}

export async function doRepeat(initData: string, orderId: string): Promise<RepeatResult> {
  const resp = await callCabinet({ action: 'repeat', initData, orderId });
  const parsed = resp ? repeatResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) return parsed.data;
  return { ok: false, error: GENERIC_ERROR, message: 'Сеть недоступна. Попробуй ещё раз.' };
}

export async function doOperator(initData: string, orderId: string): Promise<OperatorResult> {
  const resp = await callCabinet({ action: 'operator', initData, orderId });
  const parsed = resp ? operatorResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) return parsed.data;
  return { ok: false, error: GENERIC_ERROR, message: 'Сеть недоступна. Попробуй ещё раз.' };
}
