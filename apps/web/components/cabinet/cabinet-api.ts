'use client';

import { z } from 'zod';
import { servicePaymentInstructions } from '@oplati/types';

import type { PaymentIssueType } from '@/lib/cabinet/payment-issues';

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

/** Правила оплаты сервиса (VPN/валюта/billing/ссылка) — как в каталоге. */
const instructionsSchema = servicePaymentInstructions.nullable();

const cardViewSchema = z.object({
  id: z.string(),
  panMasked: z.string(),
  status: z.string(),
  statusLabel: z.string(),
  balanceUsdCents: z.number(),
  createdAt: z.string(),
  validUntil: z.string(),
  purpose: z.string().nullable(),
  purposeOrderId: z.string().nullable(),
  instructions: instructionsSchema,
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

const eventViewSchema = z.object({ label: z.string(), at: z.string(), type: z.string() });

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
  /** Реф-ссылка для главного меню (кнопка «Скопировать»); null — программа выключена. */
  referralLink: z.string().nullable(),
});

const orderDetailSchema = orderSummarySchema.extend({
  originalAmount: z.number().nullable(),
  originalCurrency: z.string().nullable(),
  commissionPercent: z.number().nullable(),
  usdtRubRateKopecks: z.number().nullable(),
  instructions: instructionsSchema,
  cardIssueFeeKopecks: z.number().nullable(),
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

/** Результат создания заказа из каталога Mini App (`doPropose`). */
const orderCreationResultSchema = z.discriminatedUnion('ok', [
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

export type OrderSummary = z.infer<typeof orderSummarySchema>;
export type CardView = z.infer<typeof cardViewSchema>;
export type CardDetailsResult = z.infer<typeof cardDetailsResultSchema>;
export type PaymentView = z.infer<typeof paymentViewSchema>;
export type OrderEventView = z.infer<typeof eventViewSchema>;
export type CabinetProfile = z.infer<typeof profileSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type OrderDetail = z.infer<typeof orderDetailSchema>;
export type PayResult = z.infer<typeof payResultSchema>;
export type OrderCreationResult = z.infer<typeof orderCreationResultSchema>;

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

/** Заказ из кнопочного каталога Mini App (форма результата — как у repeat). */
export type ProposePayload = {
  slug: string;
  tierName?: string;
  tierPeriod?: 'month' | 'quarter' | 'year';
  amountUsdCents?: number;
};

export async function doPropose(initData: string, payload: ProposePayload): Promise<OrderCreationResult> {
  const resp = await callCabinet({ action: 'propose', initData, ...payload });
  const parsed = resp ? orderCreationResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) return parsed.data;
  return { ok: false, error: GENERIC_ERROR, message: 'Сеть недоступна. Попробуй ещё раз.' };
}

// ─── Пост-выпускные действия (ТЗ «клиентский путь» §6) ─────────────────────

const paymentIssueResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), duplicate: z.boolean() }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string() }),
]);

export type PaymentIssueResult = z.infer<typeof paymentIssueResultSchema>;

/** «Не проходит оплата?»: тип проблемы + контекст заказа уходят оператору. */
export async function doReportPaymentIssue(
  initData: string,
  orderId: string,
  issueType: PaymentIssueType,
  comment?: string,
): Promise<PaymentIssueResult> {
  const resp = await callCabinet({
    action: 'payment-issue',
    initData,
    orderId,
    issueType,
    ...(comment ? { comment } : {}),
  });
  const parsed = resp ? paymentIssueResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) return parsed.data;
  return { ok: false, error: GENERIC_ERROR, message: 'Сеть недоступна. Попробуй ещё раз.' };
}

const subscriptionPaidResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string() }),
]);

export type SubscriptionPaidResult = z.infer<typeof subscriptionPaidResultSchema>;

/** «Подписка оплачена» — клиент подтвердил успех на сайте сервиса. */
export async function doMarkSubscriptionPaid(
  initData: string,
  orderId: string,
): Promise<SubscriptionPaidResult> {
  const resp = await callCabinet({ action: 'subscription-paid', initData, orderId });
  const parsed = resp ? subscriptionPaidResultSchema.safeParse(resp.json) : null;
  if (parsed?.success) return parsed.data;
  return { ok: false, error: GENERIC_ERROR, message: 'Сеть недоступна. Попробуй ещё раз.' };
}

